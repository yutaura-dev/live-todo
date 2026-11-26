import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode, type ClaudeRequest } from "../core/agent/claude-code.js";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { gmailMessage, makeTestGmail } from "../sources/gmail/test-client.js";
import { runGmailThreadTriage } from "./gmail-conversations.js";

const SOURCE = "gmail:me:threads";

const pendingThread = (threadId: string, state: "open" | "resolved" = "open") =>
  Effect.gen(function* () {
    return yield* (yield* SourceItemRepository).upsertItem({ source: SOURCE, externalId: threadId, title: "打ち合わせの件", url: `https://mail.google.com/mail/u/0/#all/${threadId}`, state, fingerprint: "v1" });
  });

const harness = (answer: unknown) => {
  const gmail = makeTestGmail([
    gmailMessage({ id: "a", threadId: "t1", receivedAt: 1, labelIds: ["INBOX"], headers: { from: "Sato <sato@example.com>", subject: "打ち合わせの件" } }),
    gmailMessage({ id: "b", threadId: "t1", receivedAt: 2, labelIds: ["SENT"], headers: { from: "me@example.com", subject: "Re: 打ち合わせの件" } }),
    gmailMessage({ id: "c", threadId: "t1", receivedAt: 3, labelIds: ["INBOX"], headers: { from: "Sato <sato@example.com>", subject: "Re: 打ち合わせの件" } }),
  ]);
  gmail.state.texts.set("a", "来週の打ち合わせの候補日をください");
  gmail.state.texts.set("b", "確認します");
  gmail.state.texts.set("c", "金曜までにお願いします");
  const requests: ClaudeRequest[] = [];
  const contexts: Array<{ owner: number | string; conversation: { messages: Array<{ who: string; isMe: boolean; subject: string; text: string }> } }> = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ClaudeCode, ClaudeCode.of({ run: (request) => Effect.sync(() => (requests.push(request), { sessionId: "s", structured: answer, costUsd: 0.01, permissionDenials: 0 })) })),
      Effect.provideService(
        AgentWorkspace,
        AgentWorkspace.of({
          prepare: () => Effect.die(new Error("使わない")),
          pullRequestState: () => Effect.die(new Error("使わない")),
          writeContext: (owner, files) => Effect.sync(() => (contexts.push({ owner, conversation: JSON.parse(files["conversation.json"]!) }), `/work/${owner}/context`)),
        }),
      ),
    );
  return { gmail, requests, contexts, run: provide(runGmailThreadTriage({ accountId: "me" }, gmail.client)) };
};

describe("runGmailThreadTriage（メールのスレッドを読ませて Task にする）", () => {
  it.effect("保留のスレッドのメールを、差出人・自分のものか・件名・本文つきで Claude Code に渡す（ファイルを読むだけ）", () =>
    Effect.gen(function* () {
      yield* pendingThread("t1");
      const h = harness({ decision: "none", title: "", brief: "", reason: "x" });

      yield* h.run;

      assert.strictEqual(h.contexts[0]!.owner, "gmail-me-t1");
      assert.deepStrictEqual(h.contexts[0]!.conversation.messages.map((entry) => [entry.who, entry.isMe, entry.text]), [
        ["Sato <sato@example.com>", false, "来週の打ち合わせの候補日をください"],
        ["me", true, "確認します"],
        ["Sato <sato@example.com>", false, "金曜までにお願いします"],
      ]);
      assert.deepStrictEqual(h.requests[0]!.allowedTools, ["Read"]);
      assert.include(h.requests[0]!.prompt, "メール");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("やることがあれば、何をするかのタイトルと状況で Task を作り、スレッドを紐づける", () =>
    Effect.gen(function* () {
      const item = yield* pendingThread("t1");
      const h = harness({ decision: "create", title: "佐藤さんに打ち合わせの候補日を返信する", brief: "金曜までに候補日を送る", reason: "依頼がある" });

      yield* h.run;

      const tasks = yield* TaskRepository;
      const task = Option.getOrThrow(yield* tasks.findTaskByItem(item.id));
      assert.deepInclude(task, { title: "佐藤さんに打ち合わせの候補日を返信する", brief: "金曜までに候補日を送る", status: "todo" });
      assert.strictEqual(Option.getOrThrow(yield* (yield* SourceItemRepository).findItem(SOURCE, "t1")).triage, "linked");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("やることがなければ対象外にする", () =>
    Effect.gen(function* () {
      yield* pendingThread("t1");
      yield* harness({ decision: "none", title: "", brief: "", reason: "お礼だけ" }).run;
      assert.strictEqual(Option.getOrThrow(yield* (yield* SourceItemRepository).findItem(SOURCE, "t1")).triage, "ignored");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("済んだスレッドは読ませない", () =>
    Effect.gen(function* () {
      yield* pendingThread("t1", "resolved");
      const h = harness({ decision: "none", title: "", brief: "", reason: "x" });
      yield* h.run;
      assert.lengthOf(h.requests, 0);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("回答の形が違ったら、保留のままにする（あとでやり直す）", () =>
    Effect.gen(function* () {
      yield* pendingThread("t1");
      yield* harness({ decision: "maybe" }).run;
      assert.strictEqual(Option.getOrThrow(yield* (yield* SourceItemRepository).findItem(SOURCE, "t1")).triage, "pending");
    }).pipe(Effect.provide(TestDatabase)));
});
