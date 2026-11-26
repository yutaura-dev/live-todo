import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode } from "../core/agent/claude-code.js";
import {
  CONVERSATION_TRIAGE_JSON_SCHEMA,
  type ConversationDecision,
  conversationKeyOf,
  conversationTriagePrompt,
  decodeConversationDecision,
} from "../core/agent/conversation-triage.js";
import { Database } from "../core/db/database.js";
import { sourceItems, taskChanges, taskLinks, tasks } from "../core/db/schema.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import type { SlackClient } from "../sources/slack/slack-client.js";
import { mentionedIds, readableSlackText } from "../sources/slack/slack-text.js";

const FINISHED = ["done", "dismissed", "archived"] as const;
// 1 回に考える会話の数。Claude Code を 1 会話ずつ呼ぶので、溜まっていても少しずつ進める
const MAX_CONVERSATIONS = 5;
// 考えられなかった会話は、しばらく置いてからやり直す（同じ失敗で使用量を使い続けないため）
const RETRY_AFTER_MS = 60 * 60 * 1000;
const failedAt = new Map<string, number>();

const inboxSource = (accountId: string) => `slack:${accountId}:inbox`;
const ownerOf = (accountId: string, key: string) => `slack-${accountId}-${key}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");

export type SlackConversationOptions = { accountId: string; model?: string; maxBudgetUsd?: number };

/**
 * 仕分けを保留にした Slack のメッセージを会話ごとにまとめ、前後のメッセージを Claude Code に読ませて、
 * やることがあれば何をするかの Task にする（既にある Task の続きなら紐づける）。やることがなければ対象外にする
 */
export const runSlackConversationTriage = (options: SlackConversationOptions, client: SlackClient["Service"]) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const taskRepository = yield* TaskRepository;
    const itemRepository = yield* SourceItemRepository;
    const claude = yield* ClaudeCode;
    const workspace = yield* AgentWorkspace;
    const source = inboxSource(options.accountId);

    const pending = yield* db
      .select()
      .from(sourceItems)
      .where(and(eq(sourceItems.source, source), eq(sourceItems.triage, "pending"), eq(sourceItems.state, "open")))
      .orderBy(asc(sourceItems.id))
      .pipe(Effect.orDie);
    if (pending.length === 0) return [];

    const groups = new Map<string, { channel: string; threadTs: string | undefined; items: typeof pending }>();
    for (const item of pending) {
      const { channel, threadTs, key } = conversationKeyOf(item.externalId, item.url);
      const group = groups.get(key) ?? { channel, threadTs, items: [] };
      group.items.push(item);
      groups.set(key, group);
    }

    const linked = yield* db
      .select({ taskId: tasks.id, title: tasks.title, brief: tasks.brief, externalId: sourceItems.externalId, url: sourceItems.url })
      .from(taskLinks)
      .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(and(eq(sourceItems.source, source), notInArray(tasks.status, [...FINISHED])))
      .pipe(Effect.orDie);
    const taskOfConversation = new Map(linked.map((row) => [conversationKeyOf(row.externalId, row.url).key, row]));

    const me = yield* client.authTest;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const decided: Array<{ key: string; decision: ConversationDecision["decision"] }> = [];
    for (const [key, group] of [...groups].slice(0, MAX_CONVERSATIONS)) {
      const failure = failedAt.get(`${options.accountId}:${key}`);
      if (failure !== undefined && now - failure < RETRY_AFTER_MS) continue;
      const existing = taskOfConversation.get(key);

      const outcome = yield* Effect.gen(function* () {
        const latestTs = group.items.map((item) => item.externalId.split(":")[1] ?? "0").toSorted((a, b) => Number(a) - Number(b)).at(-1) ?? "0";
        const messages = yield* client.conversation(group.channel, group.threadTs === undefined ? { latestTs } : { threadTs: group.threadTs });
        const users = new Map<string, string>([[me.userId, "me"]]);
        for (const id of new Set([...messages.flatMap((entry) => (entry.user === undefined ? [] : [entry.user])), ...messages.flatMap((entry) => mentionedIds(entry.text))])) {
          if (users.has(id)) continue;
          const name = yield* client.userName(id).pipe(Effect.orElseSucceed(() => Option.none<string>()));
          if (Option.isSome(name)) users.set(id, name.value);
        }
        const conversation = {
          me: "me",
          messages: messages.map((entry) => ({
            who: entry.user === undefined ? "unknown" : (users.get(entry.user) ?? entry.user),
            isMe: entry.user === me.userId,
            at: new Date(Number(entry.ts) * 1000).toISOString(),
            text: readableSlackText(entry.text, { users }),
          })),
          pending: group.items.map((item) => item.externalId),
          existingTask: existing === undefined ? null : { id: existing.taskId, title: existing.title, brief: existing.brief },
        };
        const contextDir = yield* workspace.writeContext(ownerOf(options.accountId, key), { "conversation.json": JSON.stringify(conversation, null, 2) });
        const result = yield* claude.run({
          prompt: conversationTriagePrompt({ contextDir }),
          cwd: contextDir,
          jsonSchema: CONVERSATION_TRIAGE_JSON_SCHEMA,
          // 会話のファイルを読むだけ
          allowedTools: ["Read"],
          model: options.model,
          maxBudgetUsd: options.maxBudgetUsd,
        });
        return yield* decodeConversationDecision(result.structured);
      }).pipe(Effect.result);

      if (outcome._tag === "Failure") {
        failedAt.set(`${options.accountId}:${key}`, now);
        yield* Effect.logWarning("Slack の会話から Task を決められなかった").pipe(Effect.annotateLogs({ conversation: key, reason: outcome.failure.message }));
        continue;
      }
      const decision = outcome.success;
      const judgment = { verdict: decision.decision === "none" ? "not_todo" : "todo", method: "conversation", reason: decision.reason };

      if (decision.decision === "none") {
        for (const item of group.items) yield* itemRepository.setTriage(item.id, "ignored", judgment);
      } else if (decision.decision === "update" && existing !== undefined) {
        for (const item of group.items) {
          yield* taskRepository.linkItem(existing.taskId, item.id, "tracks");
          yield* itemRepository.setTriage(item.id, "linked", judgment);
        }
        if (decision.brief.trim() !== "" && decision.brief !== existing.brief) {
          yield* taskRepository.updateTask(existing.taskId, { brief: decision.brief });
          yield* taskRepository.recordChange(existing.taskId, { kind: "field_changed", field: "brief", before: existing.brief, after: decision.brief, unread: true, actor: "agent" });
        }
      } else {
        const title = decision.title.trim() === "" ? (existing?.title ?? "Slack の会話に対応する") : decision.title.trim();
        const task = yield* taskRepository.createTask({ title, status: "todo" });
        if (decision.brief.trim() !== "") yield* taskRepository.updateTask(task.id, { brief: decision.brief });
        for (const item of group.items) {
          yield* taskRepository.linkItem(task.id, item.id, "tracks");
          yield* itemRepository.setTriage(item.id, "linked", judgment);
        }
        yield* taskRepository.recordChange(task.id, { kind: "created", after: { conversation: key, reason: decision.reason }, unread: true, actor: "agent" });
      }
      decided.push({ key, decision: decision.decision });
    }
    return decided;
  });

/**
 * メッセージ 1 件ごとに作っていた Task のうち、まだ触っていない（要確認のまま、自分で動かしていない）ものを片付け、
 * メッセージを保留に戻して、会話ごとに考え直させる。片付けた数を返す
 */
export const releaseUntouchedInboxTasks = Effect.fnUntraced(function* (accountId: string) {
  const db = yield* Database;
  const taskRepository = yield* TaskRepository;
  const itemRepository = yield* SourceItemRepository;
  const rows = yield* db
    .select({ taskId: tasks.id, itemId: sourceItems.id })
    .from(taskLinks)
    .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(and(eq(sourceItems.source, inboxSource(accountId)), eq(tasks.status, "needs_review")))
    .pipe(Effect.orDie);
  const taskIds = [...new Set(rows.map((row) => row.taskId))];
  if (taskIds.length === 0) return 0;
  const touched = new Set(
    (yield* db.select({ taskId: taskChanges.taskId }).from(taskChanges).where(and(inArray(taskChanges.taskId, taskIds), eq(taskChanges.actor, "user"))).pipe(Effect.orDie)).map(
      (row) => row.taskId,
    ),
  );
  let released = 0;
  for (const taskId of taskIds) {
    if (touched.has(taskId)) continue;
    const items = rows.filter((row) => row.taskId === taskId).map((row) => row.itemId);
    yield* db.delete(taskLinks).where(eq(taskLinks.taskId, taskId)).pipe(Effect.orDie);
    for (const itemId of items) yield* itemRepository.setTriage(itemId, "pending");
    yield* taskRepository.updateTask(taskId, { status: "dismissed" });
    yield* taskRepository.recordChange(taskId, {
      kind: "field_changed",
      field: "status",
      before: "needs_review",
      after: "dismissed",
      unread: false,
      actor: "agent",
    });
    released++;
  }
  return released;
});
