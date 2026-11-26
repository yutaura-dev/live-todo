import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, notInArray, or } from "drizzle-orm";
import { DateTime, Effect, Predicate } from "effect";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode } from "../core/agent/claude-code.js";
import { decodeMailThreadDecision, MAIL_THREAD_TRIAGE_JSON_SCHEMA, mailThreadTriagePrompt } from "../core/agent/conversation-triage.js";
import { Database } from "../core/db/database.js";
import { gmailMessages, sourceItems, taskLinks, tasks } from "../core/db/schema.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { gmailThreadsSource } from "../sources/gmail/gmail-bindings.js";
import type { GmailClient } from "../sources/gmail/gmail-client.js";

// 1 回に読ませるスレッドの数。Claude Code を 1 スレッドずつ呼ぶので、溜まっていても少しずつ進める
const MAX_THREADS = 5;
// 長いメール（引用の連なり・署名）で使用量が膨らまないよう、1 通の本文を切り詰める
const MAX_TEXT = 4000;
const RETRY_AFTER_MS = 60 * 60 * 1000;
const failedAt = new Map<string, number>();

const OPEN_STATUSES = ["todo", "in_progress", "needs_review", "agent_running"] as const;
const MAX_OPEN_TASKS = 50;
const MAX_INBOX = 60;
const INBOX_DAYS = 30;
const BRIEF_HEAD = 200;

/** 今開いている Task（送り主にまとめた Task は除く。同じ話の Task に紐づけさせるため） */
const openTasksForTriage = Effect.fnUntraced(function* (accountId: string) {
  const db = yield* Database;
  const senderTaskIds = (yield* db
    .select({ taskId: taskLinks.taskId })
    .from(taskLinks)
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(eq(sourceItems.source, `gmail:${accountId}:senders`))
    .pipe(Effect.orDie)).map((row) => row.taskId);
  const rows = yield* db
    .select({ id: tasks.id, title: tasks.title, brief: tasks.brief })
    .from(tasks)
    .where(and(inArray(tasks.status, [...OPEN_STATUSES]), senderTaskIds.length === 0 ? undefined : notInArray(tasks.id, senderTaskIds)))
    .orderBy(desc(tasks.id))
    .limit(MAX_OPEN_TASKS)
    .pipe(Effect.orDie);
  return rows.map((row) => ({ id: row.id, title: row.title, brief: (row.brief ?? "").slice(0, BRIEF_HEAD) }));
});

/** 受信トレイにある、まだどの Task にもなっていないメール（送り主にまとめているメルマガ・お知らせ） */
const inboxForTriage = Effect.fnUntraced(function* (accountId: string, exceptThread: string, now: number) {
  const db = yield* Database;
  const rows = yield* db
    .select({ messageId: gmailMessages.messageId, from: gmailMessages.senderName, subject: gmailMessages.subject, receivedAt: gmailMessages.receivedAt })
    .from(gmailMessages)
    .where(
      and(
        eq(gmailMessages.accountId, accountId),
        eq(gmailMessages.inInbox, true),
        eq(gmailMessages.trashed, false),
        inArray(gmailMessages.kind, ["newsletter", "notification"]),
        or(eq(gmailMessages.actionChecked, false), lt(gmailMessages.actionProbability, 0.5)),
        ne(gmailMessages.threadId, exceptThread),
        gte(gmailMessages.receivedAt, now - INBOX_DAYS * 24 * 60 * 60 * 1000),
      ),
    )
    .orderBy(desc(gmailMessages.receivedAt))
    .limit(MAX_INBOX)
    .pipe(Effect.orDie);
  return rows.map((row) => ({ messageId: row.messageId, from: row.from, subject: row.subject, at: new Date(row.receivedAt).toISOString() }));
});

const ownerOf = (accountId: string, threadId: string) => `gmail-${accountId}-${threadId}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * やることはないと決めたスレッドのメルマガ・お知らせを、送り主の Task に戻す（対応が要るかを 0 にする）。
 * 対応が要りそうだと読ませたあと、どの Task にも入らずアプリから片付けられなくなるのを防ぐ
 */
const returnToSender = Effect.fnUntraced(function* (accountId: string, threadIds: ReadonlyArray<string>) {
  if (threadIds.length === 0) return;
  const db = yield* Database;
  yield* db
    .update(gmailMessages)
    .set({ actionProbability: 0 })
    .where(
      and(
        eq(gmailMessages.accountId, accountId),
        inArray(gmailMessages.threadId, [...threadIds]),
        inArray(gmailMessages.kind, ["newsletter", "notification"]),
        eq(gmailMessages.actionChecked, true),
      ),
    )
    .pipe(Effect.orDie);
});

/**
 * 決め方（プロンプト）の版。変えたら上げると、前の版で「やることはない」としたスレッドを考え直させる。
 * 2: 条件つきの依頼（変更があれば連絡、など）も Task にする
 */
export const MAIL_TRIAGE_VERSION = 2;
const versionOf = (judgment: unknown) => (Predicate.isObject(judgment) && "version" in judgment ? judgment.version : undefined);

export type GmailThreadTriageOptions = { accountId: string; model?: string; maxBudgetUsd?: number };

/** 仕分けを保留にした人からのメールのスレッドを Claude Code に読ませ、やることがあれば何をするかの Task にする */
export const runGmailThreadTriage = (options: GmailThreadTriageOptions, client: GmailClient["Service"]) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const taskRepository = yield* TaskRepository;
    const itemRepository = yield* SourceItemRepository;
    const claude = yield* ClaudeCode;
    const workspace = yield* AgentWorkspace;
    const source = gmailThreadsSource(options.accountId);

    const ignored = yield* db
      .select({ id: sourceItems.id, externalId: sourceItems.externalId, judgment: sourceItems.judgment })
      .from(sourceItems)
      .where(and(eq(sourceItems.source, source), eq(sourceItems.triage, "ignored")))
      .pipe(Effect.orDie);
    const current = ignored.filter((row) => versionOf(row.judgment) === MAIL_TRIAGE_VERSION);
    const outdated = ignored.filter((row) => versionOf(row.judgment) !== MAIL_TRIAGE_VERSION);
    yield* returnToSender(options.accountId, current.map((row) => row.externalId));
    // 前の決め方で「やることはない」としたものは考え直させる。メルマガ・お知らせは送り主に戻していたので、対応が要るかから判定し直させる
    for (const row of outdated) yield* itemRepository.setTriage(row.id, "pending");
    if (outdated.length > 0) {
      yield* db
        .update(gmailMessages)
        .set({ actionChecked: false, actionProbability: null })
        .where(
          and(
            eq(gmailMessages.accountId, options.accountId),
            inArray(gmailMessages.threadId, outdated.map((row) => row.externalId)),
            inArray(gmailMessages.kind, ["newsletter", "notification"]),
          ),
        )
        .pipe(Effect.orDie);
    }

    const pending = yield* db
      .select()
      .from(sourceItems)
      .where(and(eq(sourceItems.source, source), eq(sourceItems.triage, "pending"), eq(sourceItems.state, "open")))
      .orderBy(asc(sourceItems.id))
      .pipe(Effect.orDie);

    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const decided: Array<{ threadId: string; decision: string }> = [];

    // 別のスレッドを読んだときに同じ話だと決めたメールのスレッドは、読み直さずにその Task に紐づける
    const claimed = pending.length === 0
      ? []
      : yield* db
          .select({ threadId: gmailMessages.threadId, taskId: gmailMessages.claimedTaskId })
          .from(gmailMessages)
          .where(and(eq(gmailMessages.accountId, options.accountId), inArray(gmailMessages.threadId, pending.map((item) => item.externalId)), isNotNull(gmailMessages.claimedTaskId)))
          .pipe(Effect.orDie);
    const claimedBy = new Map(claimed.map((row) => [row.threadId, row.taskId!]));
    const unclaimed: typeof pending = [];
    for (const item of pending) {
      const taskId = claimedBy.get(item.externalId);
      const task = taskId === undefined ? undefined : yield* taskRepository.findTask(taskId);
      if (task === undefined || task._tag === "None" || !(OPEN_STATUSES as ReadonlyArray<string>).includes(task.value.status)) {
        unclaimed.push(item);
        continue;
      }
      yield* taskRepository.linkItem(task.value.id, item.id, "tracks");
      yield* itemRepository.setTriage(item.id, "linked", { verdict: "todo", method: "conversation", reason: "同じ話のスレッドを読んだときに紐づけた", version: MAIL_TRIAGE_VERSION });
      yield* taskRepository.recordChange(task.value.id, { kind: "link_added", after: { thread: item.externalId }, unread: true, actor: "agent" });
      decided.push({ threadId: item.externalId, decision: "claimed" });
    }

    for (const item of unclaimed.slice(0, MAX_THREADS)) {
      const failure = failedAt.get(`${options.accountId}:${item.externalId}`);
      if (failure !== undefined && now - failure < RETRY_AFTER_MS) continue;

      const outcome = yield* Effect.gen(function* () {
        const messages = yield* client.thread(item.externalId);
        const conversation = {
          messages: messages
            .filter((message) => !message.labelIds.includes("DRAFT"))
            .map((message) => {
              const isMe = message.labelIds.includes("SENT");
              return {
                who: isMe ? "me" : (message.headers.from ?? "unknown"),
                isMe,
                at: new Date(message.receivedAt).toISOString(),
                subject: message.headers.subject ?? "",
                text: message.text.slice(0, MAX_TEXT),
              };
            }),
          existingTask: null,
        };
        const openTasks = yield* openTasksForTriage(options.accountId);
        const inbox = yield* inboxForTriage(options.accountId, item.externalId, now);
        const contextDir = yield* workspace.writeContext(ownerOf(options.accountId, item.externalId), {
          "conversation.json": JSON.stringify(conversation, null, 2),
          "open-tasks.json": JSON.stringify(openTasks, null, 2),
          "inbox.json": JSON.stringify(inbox, null, 2),
        });
        const result = yield* claude.run({
          prompt: mailThreadTriagePrompt({ contextDir }),
          cwd: contextDir,
          jsonSchema: MAIL_THREAD_TRIAGE_JSON_SCHEMA,
          // スレッドのファイルを読むだけ
          allowedTools: ["Read"],
          model: options.model,
          maxBudgetUsd: options.maxBudgetUsd,
        });
        const decision = yield* decodeMailThreadDecision(result.structured);
        return { decision, openTaskIds: new Set(openTasks.map((task) => task.id)), inboxIds: new Set(inbox.map((mail) => mail.messageId)) };
      }).pipe(Effect.result);

      if (outcome._tag === "Failure") {
        failedAt.set(`${options.accountId}:${item.externalId}`, now);
        yield* Effect.logWarning("メールのスレッドから Task を決められなかった").pipe(Effect.annotateLogs({ reason: outcome.failure.message }));
        continue;
      }
      const { decision, openTaskIds, inboxIds } = outcome.success;
      const judgment = { verdict: decision.decision === "none" ? "not_todo" : "todo", method: "conversation", reason: decision.reason, version: MAIL_TRIAGE_VERSION };
      if (decision.decision === "none") {
        yield* itemRepository.setTriage(item.id, "ignored", judgment);
        yield* returnToSender(options.accountId, [item.externalId]);
      } else {
        let taskId: number;
        const existing = decision.decision === "update" && openTaskIds.has(decision.taskId) ? yield* taskRepository.findTask(decision.taskId) : undefined;
        if (existing !== undefined && existing._tag === "Some") {
          taskId = existing.value.id;
          yield* taskRepository.linkItem(taskId, item.id, "tracks");
          yield* itemRepository.setTriage(item.id, "linked", judgment);
          yield* taskRepository.recordChange(taskId, { kind: "link_added", after: { thread: item.externalId, reason: decision.reason }, unread: true, actor: "agent" });
          if (decision.brief.trim() !== "" && decision.brief !== existing.value.brief) {
            yield* taskRepository.updateTask(taskId, { brief: decision.brief });
            yield* taskRepository.recordChange(taskId, { kind: "field_changed", field: "brief", before: existing.value.brief, after: decision.brief, unread: true, actor: "agent" });
          }
        } else {
          // update でも、一覧にない Task を挙げたなら新しく作る（勝手に別の Task へ紐づけない）
          const title = decision.title.trim() === "" ? item.title : decision.title.trim();
          const task = yield* taskRepository.createTask({ title, status: "todo" });
          taskId = task.id;
          if (decision.brief.trim() !== "") yield* taskRepository.updateTask(task.id, { brief: decision.brief });
          yield* taskRepository.linkItem(task.id, item.id, "tracks");
          yield* itemRepository.setTriage(item.id, "linked", judgment);
          yield* taskRepository.recordChange(task.id, { kind: "created", after: { thread: item.externalId, reason: decision.reason }, unread: true, actor: "agent" });
        }
        const related = decision.related.filter((messageId) => inboxIds.has(messageId));
        if (related.length > 0) {
          // 送り主の Task から外し（対応が要るものとして扱う）、次の同期でスレッドができたら、読み直さずにこの Task に紐づける
          yield* db
            .update(gmailMessages)
            .set({ actionChecked: true, actionProbability: 1, claimedTaskId: taskId })
            .where(and(eq(gmailMessages.accountId, options.accountId), inArray(gmailMessages.messageId, related)))
            .pipe(Effect.orDie);
        }
      }
      decided.push({ threadId: item.externalId, decision: decision.decision });
    }
    return decided;
  });
