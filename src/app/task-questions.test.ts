import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { Database } from "../core/db/database.js";
import { agentRuns } from "../core/db/schema.js";
import { TestClock } from "effect/testing";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode, type ClaudeRequest } from "../core/agent/claude-code.js";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { answerQuestion, askQuestion, listQuestions, QUESTION_TOOLS, recoverInterruptedQuestions } from "./task-questions.js";

const harness = (answer: unknown = { answer: "11/27 の 19:00 からです", sources: ["mail.json"] }) => {
  const requests: ClaudeRequest[] = [];
  const contexts: Array<{ owner: number | string; files: Record<string, string> }> = [];
  const prepared: string[] = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ClaudeCode, ClaudeCode.of({ run: (request) => Effect.sync(() => (requests.push(request), { sessionId: `s${requests.length}`, structured: answer, costUsd: 0.02, permissionDenials: 0 })) })),
      Effect.provideService(
        AgentWorkspace,
        AgentWorkspace.of({
          prepare: (repository) => Effect.sync(() => (prepared.push(repository), { cwd: `/work/repo/${repository}`, contextDir: "/work/pr", headSha: undefined })),
          pullRequestState: () => Effect.succeed("{}"),
          writeContext: (owner, files) => Effect.sync(() => (contexts.push({ owner, files: { ...files } }), `/work/${owner}/context`)),
        }),
      ),
    );
  return { requests, contexts, prepared, provide };
};

const taskWithItem = (source: string, url: string) =>
  Effect.gen(function* () {
    const item = yield* (yield* SourceItemRepository).upsertItem({ source, externalId: "x", title: "元の項目", url, state: "open", fingerprint: "v1" });
    const tasks = yield* TaskRepository;
    const task = yield* tasks.createTask({ title: "ケトル通りの招待に返答する", status: "todo" });
    yield* tasks.updateTask(task.id, { brief: "11/27 の飲み会の招待" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    return task.id;
  });

describe("Task への質問", () => {
  it.effect("質問を受け付けると、調べている途中として記録する", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 10, 26));
      const taskId = yield* taskWithItem("gmail:mail:threads", "https://mail.google.com/mail/u/0/#all/t1");

      const id = yield* askQuestion(taskId, "  何時から？ ");

      const [question] = yield* listQuestions(taskId);
      assert.deepInclude(question, { id, question: "何時から？", status: "running", answer: null });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("空の質問は受け付けない", () =>
    Effect.gen(function* () {
      const taskId = yield* taskWithItem("gmail:mail:threads", "https://mail.google.com/");
      const error = yield* askQuestion(taskId, "   ").pipe(Effect.flip);
      assert.include(error.message, "質問");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("Task の情報と、渡された追加の材料（メールの本文など）を書き出し、読む・探す・検索だけで調べさせて回答を残す", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 10, 26));
      const taskId = yield* taskWithItem("gmail:mail:threads", "https://mail.google.com/mail/u/0/#all/t1");
      const id = yield* askQuestion(taskId, "何時から？");

      yield* h.provide(answerQuestion(id, { extraContext: () => Effect.succeed({ "mail.json": "[{\"text\":\"19:00 から\"}]" }) }));

      const task = JSON.parse(h.contexts[0]!.files["task.json"]!);
      assert.deepInclude(task, { title: "ケトル通りの招待に返答する", brief: "11/27 の飲み会の招待" });
      assert.strictEqual(h.contexts[0]!.files["mail.json"], '[{"text":"19:00 から"}]');
      assert.include(h.requests[0]!.prompt, "何時から？");
      assert.deepStrictEqual([...(h.requests[0]!.allowedTools ?? [])], [...QUESTION_TOOLS]);
      assert.notInclude(QUESTION_TOOLS, "Bash");
      assert.notInclude(QUESTION_TOOLS, "WebFetch");
      const [question] = yield* listQuestions(taskId);
      assert.deepInclude(question, { status: "answered", answer: "11/27 の 19:00 からです" });
      assert.deepStrictEqual(question!.sources, ["mail.json"]);
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("GitHub の PR を追う Task なら、そのリポジトリを読める場所で調べさせる", () => {
    const h = harness();
    return Effect.gen(function* () {
      const taskId = yield* taskWithItem("github:personal", "https://github.com/acme/app/pull/42");
      const id = yield* askQuestion(taskId, "この PR は何を変える？");
      yield* h.provide(answerQuestion(id, {}));
      assert.deepStrictEqual(h.prepared, ["acme/app"]);
      assert.strictEqual(h.requests[0]!.cwd, "/work/repo/acme/app");
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("続けて質問すると、前の質問と回答を渡し、同じ会話の続きとして聞く", () => {
    const h = harness();
    return Effect.gen(function* () {
      const taskId = yield* taskWithItem("gmail:mail:threads", "https://mail.google.com/");
      yield* h.provide(answerQuestion(yield* askQuestion(taskId, "何時から？"), {}));
      yield* h.provide(answerQuestion(yield* askQuestion(taskId, "場所は？"), {}));

      assert.strictEqual(h.requests[1]!.resumeSessionId, "s1");
      assert.include(h.contexts[1]!.files["questions.json"]!, "何時から？");
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("回答の形が違ったら、失敗として残す", () => {
    const h = harness({ nope: true });
    return Effect.gen(function* () {
      const taskId = yield* taskWithItem("gmail:mail:threads", "https://mail.google.com/");
      yield* h.provide(answerQuestion(yield* askQuestion(taskId, "何時から？"), {}));
      const [question] = yield* listQuestions(taskId);
      assert.strictEqual(question!.status, "failed");
      assert.isNotNull(question!.error);
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("アプリを閉じて調べている途中で止まった質問は、起動したときに失敗として残す（ずっと調べている途中に見せない）", () =>
    Effect.gen(function* () {
      const taskId = yield* taskWithItem("gmail:mail:threads", "https://mail.google.com/");
      yield* askQuestion(taskId, "何時から？");

      assert.strictEqual(yield* recoverInterruptedQuestions, 1);

      const [question] = yield* listQuestions(taskId);
      assert.deepInclude(question, { status: "failed" });
      assert.include(question!.error ?? "", "もう一度");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("質問を調べている間は Task を処理中のレーンに移し、答え終わったら元のレーンに戻す（失敗しても戻す）", () => {
    const h = harness();
    const failing = harness({ nope: true });
    return Effect.gen(function* () {
      const taskId = yield* taskWithItem("gmail:mail:threads", "https://mail.google.com/");
      const tasks = yield* TaskRepository;
      const statusOf = tasks.findTask(taskId).pipe(Effect.map((task) => Option.getOrThrow(task).status));

      const id = yield* askQuestion(taskId, "何時から？");
      assert.strictEqual(yield* statusOf, "agent_running");
      yield* h.provide(answerQuestion(id, {}));
      assert.strictEqual(yield* statusOf, "todo");

      yield* failing.provide(answerQuestion(yield* askQuestion(taskId, "場所は？"), {}));
      assert.strictEqual(yield* statusOf, "todo");
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("ほかの調べものが動いている Task は、それが終わるまで処理中のままにする", () => {
    const h = harness();
    return Effect.gen(function* () {
      const taskId = yield* taskWithItem("gmail:mail:threads", "https://mail.google.com/");
      const db = yield* Database;
      yield* db.insert(agentRuns).values({ taskId, kind: "next_actions", status: "running", subjectFingerprint: "", previousStatus: "todo", startedAt: "2026-11-26T00:00:00.000Z" }).pipe(Effect.orDie);
      yield* (yield* TaskRepository).updateTask(taskId, { status: "agent_running" });

      yield* h.provide(answerQuestion(yield* askQuestion(taskId, "何時から？"), {}));

      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "agent_running");
    }).pipe(Effect.provide(TestDatabase));
  });
});
