import { and, asc, eq, inArray } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode } from "../core/agent/claude-code.js";
import { CONVERSATION_TRIAGE_JSON_SCHEMA, decodeConversationDecision, mailThreadTriagePrompt } from "../core/agent/conversation-triage.js";
import { Database } from "../core/db/database.js";
import { gmailMessages, sourceItems } from "../core/db/schema.js";
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
      .select({ externalId: sourceItems.externalId })
      .from(sourceItems)
      .where(and(eq(sourceItems.source, source), eq(sourceItems.triage, "ignored")))
      .pipe(Effect.orDie);
    yield* returnToSender(options.accountId, ignored.map((row) => row.externalId));

    const pending = yield* db
      .select()
      .from(sourceItems)
      .where(and(eq(sourceItems.source, source), eq(sourceItems.triage, "pending"), eq(sourceItems.state, "open")))
      .orderBy(asc(sourceItems.id))
      .pipe(Effect.orDie);

    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const decided: Array<{ threadId: string; decision: string }> = [];
    for (const item of pending.slice(0, MAX_THREADS)) {
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
        const contextDir = yield* workspace.writeContext(ownerOf(options.accountId, item.externalId), { "conversation.json": JSON.stringify(conversation, null, 2) });
        const result = yield* claude.run({
          prompt: mailThreadTriagePrompt({ contextDir }),
          cwd: contextDir,
          jsonSchema: CONVERSATION_TRIAGE_JSON_SCHEMA,
          // スレッドのファイルを読むだけ
          allowedTools: ["Read"],
          model: options.model,
          maxBudgetUsd: options.maxBudgetUsd,
        });
        return yield* decodeConversationDecision(result.structured);
      }).pipe(Effect.result);

      if (outcome._tag === "Failure") {
        failedAt.set(`${options.accountId}:${item.externalId}`, now);
        yield* Effect.logWarning("メールのスレッドから Task を決められなかった").pipe(Effect.annotateLogs({ reason: outcome.failure.message }));
        continue;
      }
      const decision = outcome.success;
      const judgment = { verdict: decision.decision === "none" ? "not_todo" : "todo", method: "conversation", reason: decision.reason };
      if (decision.decision === "none") {
        yield* itemRepository.setTriage(item.id, "ignored", judgment);
        yield* returnToSender(options.accountId, [item.externalId]);
      } else {
        const title = decision.title.trim() === "" ? item.title : decision.title.trim();
        const task = yield* taskRepository.createTask({ title, status: "todo" });
        if (decision.brief.trim() !== "") yield* taskRepository.updateTask(task.id, { brief: decision.brief });
        yield* taskRepository.linkItem(task.id, item.id, "tracks");
        yield* itemRepository.setTriage(item.id, "linked", judgment);
        yield* taskRepository.recordChange(task.id, { kind: "created", after: { thread: item.externalId, reason: decision.reason }, unread: true, actor: "agent" });
      }
      decided.push({ threadId: item.externalId, decision: decision.decision });
    }
    return decided;
  });
