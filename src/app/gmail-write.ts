import { and, asc, eq, inArray } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";
import { Database } from "../core/db/database.js";
import { approvals, gmailMessages, sourceItems, taskLinks } from "../core/db/schema.js";
import { applyItemState } from "../core/sync/sync-source.js";
import type { GmailClient } from "../sources/gmail/gmail-client.js";

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

/** ゴミ箱に入れる候補。送り主なら受信トレイに残っているもの、スレッドならゴミ箱に入っていないもの */
const candidates = Effect.fnUntraced(function* (group: { accountId: string; kind: "senders" | "threads"; externalId: string }) {
  const db = yield* Database;
  const rows = yield* db
    .select({ messageId: gmailMessages.messageId, subject: gmailMessages.subject, senderName: gmailMessages.senderName, receivedAt: gmailMessages.receivedAt, inInbox: gmailMessages.inInbox })
    .from(gmailMessages)
    .where(
      and(
        eq(gmailMessages.accountId, group.accountId),
        eq(gmailMessages.trashed, false),
        group.kind === "senders" ? eq(gmailMessages.senderKey, group.externalId) : eq(gmailMessages.threadId, group.externalId),
      ),
    )
    .orderBy(asc(gmailMessages.receivedAt), asc(gmailMessages.messageId))
    .pipe(Effect.orDie);
  return group.kind === "senders" ? rows.filter((row) => row.inInbox) : rows;
});

/** 承認の確認に見せる、ゴミ箱に入れるメールの一覧 */
export const gmailTrashTarget = Effect.fnUntraced(function* (taskId: number) {
  const group = yield* trackedGroup(taskId);
  const messages = yield* candidates(group);
  return { kind: group.kind, messages: messages.map(({ messageId, subject, senderName, receivedAt }) => ({ messageId, subject, senderName, receivedAt })) };
});

/**
 * 外部への書き込み。ユーザーが確認で承認したメール（approved）だけをゴミ箱に入れる。承認のあとに届いたものは入れない。
 * 失敗したらそこで止め、やり直さない（書き込みは二重に効くおそれがあるため）
 */
export const gmailTrash = Effect.fnUntraced(function* <E, R>(
  taskId: number,
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
    action: "gmail_trash",
    target: `${group.source} ${group.externalId}`,
    payload: { messageIds: targets },
    approvedAt: DateTime.formatIso(yield* DateTime.now),
  };

  const done: string[] = [];
  let failure: string | undefined;
  for (const id of targets) {
    const result = yield* client.trash(id).pipe(Effect.result);
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
      .set({ trashed: true, inInbox: false, updatedAt: executedAt })
      .where(and(eq(gmailMessages.accountId, group.accountId), inArray(gmailMessages.messageId, done)))
      .pipe(Effect.orDie);
  }
  if (failure !== undefined) {
    yield* db.insert(approvals).values({ ...record, status: "failed", error: failure, executedAt }).pipe(Effect.orDie);
    return yield* new GmailWriteError({ message: `${done.length} 通をゴミ箱に入れたところで止めた: ${failure}` });
  }
  yield* db.insert(approvals).values({ ...record, status: "executed", executedAt }).pipe(Effect.orDie);
  if ((yield* candidates(group)).length === 0) yield* applyItemState(group.source, group.externalId, "resolved");
  return { trashed: done.length };
});
