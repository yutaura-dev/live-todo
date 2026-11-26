import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode, type ClaudeRequest } from "../core/agent/claude-code.js";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { slackClientStub } from "../sources/slack/test-client.js";
import { releaseUntouchedInboxTasks, runSlackConversationTriage } from "./slack-conversations.js";

const SOURCE = "slack:home:inbox";
const message = (externalId: string, url: string) =>
  Effect.gen(function* () {
    return yield* (yield* SourceItemRepository).upsertItem({ source: SOURCE, externalId, title: "#general: x", url, state: "open", fingerprint: "v1" });
  });

const harness = (answers: Record<string, unknown>) => {
  const requests: ClaudeRequest[] = [];
  const contexts: Array<{ owner: number | string; conversation: { me: string; messages: Array<{ who: string; isMe: boolean; text: string }>; pending: string[]; existingTask: unknown } }> = [];
  const conversations: string[] = [];
  const client = slackClientStub({
    authTest: Effect.succeed({ userId: "U1", user: "me", team: "Home" }),
    userName: (id) => Effect.succeed(id === "U2" ? Option.some("hanako") : Option.none()),
    conversation: (channel, options) =>
      Effect.sync(() => {
        conversations.push(`${channel} ${JSON.stringify(options)}`);
        return [
          { ts: "1.0", user: "U2", text: "見積もりの日程を教えてください" },
          { ts: "2.0", user: "U1", text: "確認します" },
          { ts: "3.0", user: "U2", text: "<@U1> 金曜までにお願いします" },
        ];
      }),
  });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        ClaudeCode,
        ClaudeCode.of({
          run: (request) =>
            Effect.sync(() => {
              requests.push(request);
              const key = request.cwd.split("/").at(-2) ?? "";
              return { sessionId: "s", structured: answers[key] ?? { decision: "none", title: "", brief: "", reason: "雑談" }, costUsd: 0.01, permissionDenials: 0 };
            }),
        }),
      ),
      Effect.provideService(
        AgentWorkspace,
        AgentWorkspace.of({
          prepare: () => Effect.die(new Error("使わない")),
          pullRequestState: () => Effect.die(new Error("使わない")),
          writeContext: (owner, files) =>
            Effect.sync(() => {
              contexts.push({ owner, conversation: JSON.parse(files["conversation.json"]!) });
              return `/work/${owner}/context`;
            }),
        }),
      ),
    );
  return { requests, contexts, conversations, client, provide };
};

const run = (h: ReturnType<typeof harness>) => h.provide(runSlackConversationTriage({ accountId: "home" }, h.client));

describe("Slack の会話から Task を決める", () => {
  it.effect("保留のメッセージを会話ごとにまとめ、前後のメッセージ（名前つき）を Claude Code に渡す", () =>
    Effect.gen(function* () {
      yield* message("C1:3.0", "https://home.slack.com/archives/C1/p30?thread_ts=1.0&cid=C1");
      yield* message("C1:4.0", "https://home.slack.com/archives/C1/p40?thread_ts=1.0&cid=C1");
      const h = harness({});

      yield* run(h);

      assert.lengthOf(h.requests, 1);
      assert.deepStrictEqual(h.conversations, ['C1 {"threadTs":"1.0"}']);
      const context = h.contexts[0]!;
      assert.strictEqual(context.owner, "slack-home-c1-thread-1-0");
      assert.deepStrictEqual(context.conversation.messages.map((entry) => [entry.who, entry.isMe, entry.text]), [
        ["hanako", false, "見積もりの日程を教えてください"],
        ["me", true, "確認します"],
        ["hanako", false, "@me 金曜までにお願いします"],
      ]);
      assert.deepStrictEqual(context.conversation.pending, ["C1:3.0", "C1:4.0"]);
      assert.isNull(context.conversation.existingTask);
      assert.deepStrictEqual([...(h.requests[0]?.allowedTools ?? [])], ["Read"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("やることがあれば、何をするかのタイトルと状況の Task を 1 つ作り、会話のメッセージをまとめて紐づける", () =>
    Effect.gen(function* () {
      const a = yield* message("C1:3.0", "https://home.slack.com/archives/C1/p30?thread_ts=1.0&cid=C1");
      const b = yield* message("C1:4.0", "https://home.slack.com/archives/C1/p40?thread_ts=1.0&cid=C1");
      const h = harness({ "slack-home-c1-thread-1-0": { decision: "create", title: "hanako さんに見積もりの日程を返信する", brief: "金曜までに日程を返す", reason: "依頼されている" } });

      yield* run(h);

      const tasks = yield* TaskRepository;
      const task = Option.getOrThrow(yield* tasks.findTaskByItem(a.id));
      assert.deepInclude(task, { title: "hanako さんに見積もりの日程を返信する", brief: "金曜までに日程を返す", status: "todo" });
      assert.strictEqual(Option.getOrThrow(yield* tasks.findTaskByItem(b.id)).id, task.id);
      assert.strictEqual(Option.getOrThrow(yield* (yield* SourceItemRepository).findItem(SOURCE, "C1:3.0")).triage, "linked");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("やることがなければ Task を作らず、メッセージを対象外にする（次からは考えない）", () =>
    Effect.gen(function* () {
      yield* message("C1:3.0", "https://home.slack.com/archives/C1/p30?thread_ts=1.0&cid=C1");
      const h = harness({});

      yield* run(h);
      yield* run(h);

      assert.lengthOf(yield* (yield* TaskRepository).listTasks, 0);
      assert.strictEqual(Option.getOrThrow(yield* (yield* SourceItemRepository).findItem(SOURCE, "C1:3.0")).triage, "ignored");
      assert.lengthOf(h.requests, 1);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("同じ会話に既にある Task があれば渡し、続きなら新しく作らずに紐づけて状況を書き直す", () =>
    Effect.gen(function* () {
      const first = yield* message("C1:3.0", "https://home.slack.com/archives/C1/p30?thread_ts=1.0&cid=C1");
      const tasks = yield* TaskRepository;
      const existing = yield* tasks.createTask({ title: "見積もりの日程を返す", status: "todo" });
      yield* tasks.linkItem(existing.id, first.id, "tracks");
      yield* (yield* SourceItemRepository).setTriage(first.id, "linked");
      const next = yield* message("C1:5.0", "https://home.slack.com/archives/C1/p50?thread_ts=1.0&cid=C1");
      const h = harness({ "slack-home-c1-thread-1-0": { decision: "update", title: "", brief: "金曜までと念押しされた", reason: "同じ用件" } });

      yield* run(h);

      assert.deepInclude(h.contexts[0]?.conversation.existingTask as object, { id: existing.id, title: "見積もりの日程を返す" });
      assert.strictEqual(Option.getOrThrow(yield* tasks.findTaskByItem(next.id)).id, existing.id);
      assert.strictEqual(Option.getOrThrow(yield* tasks.findTask(existing.id)).brief, "金曜までと念押しされた");
      assert.lengthOf(yield* tasks.listTasks, 1);
    }).pipe(Effect.provide(TestDatabase)));
});

describe("releaseUntouchedInboxTasks（メッセージ 1 件ごとに作っていた Task を片付けて、考え直させる）", () => {
  it.effect("触っていない要確認の Task は片付け、メッセージを保留に戻す。自分で動かした Task は残す", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const items = yield* SourceItemRepository;
      const untouchedItem = yield* message("C1:3.0", "https://home.slack.com/archives/C1/p30");
      const untouched = yield* tasks.createTask({ title: "#general: x", status: "needs_review" });
      yield* tasks.linkItem(untouched.id, untouchedItem.id, "tracks");
      yield* items.setTriage(untouchedItem.id, "linked");
      const touchedItem = yield* message("C1:9.0", "https://home.slack.com/archives/C1/p90");
      const touched = yield* tasks.createTask({ title: "#general: y", status: "needs_review" });
      yield* tasks.linkItem(touched.id, touchedItem.id, "tracks");
      yield* items.setTriage(touchedItem.id, "linked");
      yield* tasks.updateTask(touched.id, { status: "todo" });
      yield* tasks.recordChange(touched.id, { kind: "field_changed", field: "status", before: "needs_review", after: "todo", unread: false, actor: "user" });

      assert.strictEqual(yield* releaseUntouchedInboxTasks("home"), 1);

      assert.strictEqual(Option.getOrThrow(yield* tasks.findTask(untouched.id)).status, "dismissed");
      assert.isTrue(Option.isNone(yield* tasks.findTaskByItem(untouchedItem.id)));
      assert.strictEqual(Option.getOrThrow(yield* items.findItem(SOURCE, "C1:3.0")).triage, "pending");
      assert.strictEqual(Option.getOrThrow(yield* tasks.findTask(touched.id)).status, "todo");
    }).pipe(Effect.provide(TestDatabase)));
});
