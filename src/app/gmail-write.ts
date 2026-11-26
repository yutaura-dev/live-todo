import { and, asc, eq, inArray } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";
import { Database } from "../core/db/database.js";
import { approvals, gmailMessages, sourceItems, taskLinks } from "../core/db/schema.js";
import { applyItemState } from "../core/sync/sync-source.js";
import { completeStep, decodePlan, type GmailStepActions, type Step } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { gmailLabelChangesOf, isReservedLabelName } from "../core/rules/rule.js";
import { Option } from "effect";
import type { GmailClient } from "../sources/gmail/gmail-client.js";
import { effectiveKind, isPastInvite } from "../sources/gmail/gmail-mailbox.js";

export class GmailWriteError extends Schema.TaggedError<GmailWriteError>()("GmailWriteError", { message: Schema.String }) {}

const SOURCE = /^gmail:([a-z0-9][a-z0-9-]*):(senders|threads)$/;

/** Task が追う Gmail のまとまり（送り主かスレッド） */
const trackedGroup = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const rows = yield* db
    .select({ source: sourceItems.source, externalId: sourceItems.externalId })
    .from(taskLinks)
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.role, "tracks")))
    .pipe(Effect.orDie);
  for (const row of rows) {
    const match = SOURCE.exec(row.source);
    if (match !== null) return { accountId: match[1]!, kind: match[2] as "senders" | "threads", source: row.source, externalId: row.externalId };
  }
  return yield* new GmailWriteError({ message: "Gmail のメールを追う Task ではない" });
});

/** 送り主のまとまりの鍵（送り主#用件）を分ける。用件のない古い鍵は「その他」として扱う */
const senderOfGroup = (externalId: string) => {
  const index = externalId.lastIndexOf("#");
  return index === -1 ? { senderKey: externalId, topic: "other" } : { senderKey: externalId.slice(0, index), topic: externalId.slice(index + 1) };
};

/** ゴミ箱に入れる候補。送り主なら受信トレイに残っているもの、スレッドならゴミ箱に入っていないもの */
const candidates = Effect.fnUntraced(function* (group: { accountId: string; kind: "senders" | "threads"; externalId: string }) {
  const db = yield* Database;
  const rows = yield* db
    .select({
      messageId: gmailMessages.messageId,
      subject: gmailMessages.subject,
      senderName: gmailMessages.senderName,
      receivedAt: gmailMessages.receivedAt,
      inInbox: gmailMessages.inInbox,
      inviteState: gmailMessages.inviteState,
      inviteEndsAt: gmailMessages.inviteEndsAt,
      kind: gmailMessages.kind,
      actionChecked: gmailMessages.actionChecked,
      actionProbability: gmailMessages.actionProbability,
      topic: gmailMessages.topic,
    })
    .from(gmailMessages)
    .where(
      and(
        eq(gmailMessages.accountId, group.accountId),
        eq(gmailMessages.trashed, false),
        group.kind === "senders" ? eq(gmailMessages.senderKey, senderOfGroup(group.externalId).senderKey) : eq(gmailMessages.threadId, group.externalId),
      ),
    )
    .orderBy(asc(gmailMessages.receivedAt), asc(gmailMessages.messageId))
    .pipe(Effect.orDie);
  // 対応を求めるメールは人からのメールとして別の Task にしているので、送り主の Task からは片付けない
  if (group.kind !== "senders") return rows;
  const { topic } = senderOfGroup(group.externalId);
  return rows.filter((row) => row.inInbox && effectiveKind(row) !== "personal" && (row.topic ?? "other") === topic);
});

/** 承認の確認に見せる、確認済みにする・ゴミ箱に入れるメールの一覧 */
export const gmailMailTarget = Effect.fnUntraced(function* (taskId: number) {
  const group = yield* trackedGroup(taskId);
  const messages = yield* candidates(group);
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  return {
    kind: group.kind,
    messages: messages.map((row) => ({ messageId: row.messageId, subject: row.subject, senderName: row.senderName, receivedAt: row.receivedAt, pastInvite: isPastInvite(row, now) })),
  };
});

/** archive: 確認済みにする（アーカイブして既読にする） / trash: ゴミ箱に入れる */
export type GmailMailAction = "archive" | "trash";

const ACTIONS: Record<GmailMailAction, { approval: string; label: string; applied: { inInbox: false; unread?: false; trashed?: true } }> = {
  // 既読にもする理由: 送り主ごとの集計で「読まずにアーカイブした（片付けた）」に数えず、読んでいるメールとして扱うため
  archive: { approval: "gmail_archive", label: "確認済みにした", applied: { inInbox: false, unread: false } },
  trash: { approval: "gmail_trash", label: "ゴミ箱に入れた", applied: { inInbox: false, trashed: true } },
};

/**
 * 外部への書き込み。ユーザーが確認で承認したメール（approved）だけを確認済みにする・ゴミ箱に入れる。承認のあとに届いたものは扱わない。
 * 失敗したらそこで止め、やり直さない（書き込みは二重に効くおそれがあるため）
 */
export const gmailProcess = Effect.fnUntraced(function* <E, R>(
  taskId: number,
  action: GmailMailAction,
  approved: ReadonlyArray<string>,
  clientFor: (accountId: string) => Effect.Effect<GmailClient["Service"], E, R>,
) {
  const db = yield* Database;
  const group = yield* trackedGroup(taskId);
  const allowed = new Set(approved);
  const targets = (yield* candidates(group)).map((row) => row.messageId).filter((id) => allowed.has(id));
  const client = yield* clientFor(group.accountId);
  const record = {
    taskId,
    action: ACTIONS[action].approval,
    target: `${group.source} ${group.externalId}`,
    payload: { messageIds: targets },
    approvedAt: DateTime.formatIso(yield* DateTime.now),
  };

  const done: string[] = [];
  let failure: string | undefined;
  for (const id of targets) {
    const result = yield* (action === "archive" ? client.archive(id) : client.trash(id)).pipe(Effect.result);
    if (result._tag === "Failure") {
      failure = result.failure._tag === "GmailRequestError" ? result.failure.message : "Gmail に書き込めなかった";
      break;
    }
    done.push(id);
  }
  const executedAt = DateTime.formatIso(yield* DateTime.now);
  if (done.length > 0) {
    yield* db
      .update(gmailMessages)
      .set({ ...ACTIONS[action].applied, updatedAt: executedAt })
      .where(and(eq(gmailMessages.accountId, group.accountId), inArray(gmailMessages.messageId, done)))
      .pipe(Effect.orDie);
  }
  if (failure !== undefined) {
    yield* db.insert(approvals).values({ ...record, status: "failed", error: failure, executedAt }).pipe(Effect.orDie);
    return yield* new GmailWriteError({ message: `${done.length} 通を${ACTIONS[action].label}ところで止めた: ${failure}` });
  }
  yield* db.insert(approvals).values({ ...record, status: "executed", executedAt }).pipe(Effect.orDie);
  if ((yield* candidates(group)).every((row) => !row.inInbox)) yield* applyItemState(group.source, group.externalId, "resolved");
  return { processed: done.length };
});

const findStep = (steps: ReadonlyArray<Step>, stepId: string): Step | undefined => {
  for (const step of steps) {
    if (step.id === stepId) return step;
    if (step.kind === "decision") {
      for (const option of step.options) {
        const found = findStep(option.steps, stepId);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
};

/**
 * 外部への書き込み。Gmail の操作の手順（ラベル・既読・アーカイブ）を、ユーザーが押して承認したメール（approved）に行い、手順を済みにする。
 * 失敗したらそこで止め、やり直さない（書き込みは二重に効くおそれがあるため）
 */
export const gmailRunStep = Effect.fnUntraced(function* <E, R>(
  taskId: number,
  stepId: string,
  approved: ReadonlyArray<string>,
  clientFor: (accountId: string) => Effect.Effect<GmailClient["Service"], E, R>,
) {
  const db = yield* Database;
  const tasks = yield* TaskRepository;
  const task = yield* tasks.findTask(taskId);
  const plan = Option.flatMap(task, (value) => decodePlan(value.nextActions));
  const step = Option.isNone(plan) ? undefined : findStep(plan.value.steps, stepId);
  if (step === undefined || step.kind !== "gmail_action" || step.gmail === undefined) return yield* new GmailWriteError({ message: "Gmail の操作の手順ではない" });
  const actions: GmailStepActions = step.gmail;
  const group = yield* trackedGroup(taskId);
  const allowed = new Set(approved);
  const targets = (yield* candidates(group)).map((row) => row.messageId).filter((id) => allowed.has(id));
  const client = yield* clientFor(group.accountId);

  const labelIds = new Map<string, string>();
  const done: string[] = [];
  let failure: string | undefined;
  const outcome = yield* Effect.gen(function* () {
    if ((actions.labels ?? []).length > 0) {
      // 利用者のラベルだけを名前で引く（TRASH などのシステムのラベルを、名前から付けさせない）
      for (const label of yield* client.labels) if (label.id.startsWith("Label_")) labelIds.set(label.name, label.id);
      for (const name of actions.labels ?? []) if (!labelIds.has(name) && !isReservedLabelName(name)) labelIds.set(name, (yield* client.createLabel(name)).id);
    }
  }).pipe(Effect.result);
  if (outcome._tag === "Failure") failure = outcome.failure._tag === "GmailRequestError" ? outcome.failure.message : "Gmail に書き込めなかった";
  for (const id of failure === undefined ? targets : []) {
    const result = yield* client.modifyLabels(id, gmailLabelChangesOf(actions, labelIds)).pipe(Effect.result);
    if (result._tag === "Failure") {
      failure = result.failure._tag === "GmailRequestError" ? result.failure.message : "Gmail に書き込めなかった";
      break;
    }
    done.push(id);
  }
  const executedAt = DateTime.formatIso(yield* DateTime.now);
  if (done.length > 0) {
    yield* db
      .update(gmailMessages)
      .set({ ...(actions.markRead === true ? { unread: false } : {}), ...(actions.archive === true ? { inInbox: false } : {}), updatedAt: executedAt })
      .where(and(eq(gmailMessages.accountId, group.accountId), inArray(gmailMessages.messageId, done)))
      .pipe(Effect.orDie);
  }
  const record = { taskId, action: "gmail_actions", target: `${group.source} ${group.externalId}`, payload: { messageIds: done, actions }, approvedAt: executedAt, executedAt };
  if (failure !== undefined) {
    yield* db.insert(approvals).values({ ...record, status: "failed", error: failure }).pipe(Effect.orDie);
    return yield* new GmailWriteError({ message: `${done.length} 通に行ったところで止めた: ${failure}` });
  }
  yield* db.insert(approvals).values({ ...record, status: "executed" }).pipe(Effect.orDie);
  // すべての手順が済めば Task は完了になる
  yield* tasks.updateTask(taskId, { nextActions: completeStep(Option.getOrThrow(plan), stepId) }, "user");
  if (actions.archive === true && (yield* candidates(group)).every((row) => !row.inInbox)) yield* applyItemState(group.source, group.externalId, "resolved");
  return { processed: done.length };
});
