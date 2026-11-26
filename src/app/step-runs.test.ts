import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode, type ClaudeRequest } from "../core/agent/claude-code.js";
import { TestDatabase } from "../core/db/test-database.js";
import { decodePlan, type NextActionPlan } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { recoverInterruptedStepRuns, runAutoSteps, runStep, startStepRun, STEP_JSON_SCHEMA } from "./step-runs.js";
import { QUESTION_TOOLS } from "./task-questions.js";

const harness = (structured: unknown = { done: true, report: "経緯は 11/20 のメールで〜" }) => {
  const requests: ClaudeRequest[] = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ClaudeCode, ClaudeCode.of({ run: (request) => Effect.sync(() => (requests.push(request), { sessionId: "s1", structured, costUsd: 0.01, permissionDenials: 0 })) })),
      Effect.provideService(
        AgentWorkspace,
        AgentWorkspace.of({
          prepare: () => Effect.die("使わない"),
          pullRequestState: () => Effect.succeed("{}"),
          writeContext: (owner) => Effect.succeed(`/work/${owner}/context`),
        }),
      ),
    );
  return { requests, provide };
};

const step = (id: string, title: string, actor: string, status = "todo") => ({ id, kind: "manual", title, effort: "normal", mode: "serial", status, actor });

const taskWithPlan = (steps: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.UTC(2026, 10, 26));
    const tasks = yield* TaskRepository;
    const task = yield* tasks.createTask({ title: "権限の更新を確かめる", status: "todo" });
    yield* tasks.updateTask(task.id, { nextActions: { steps } });
    return task.id;
  });

const loaded = (taskId: number) =>
  Effect.gen(function* () {
    const task = Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId));
    return { status: task.status, plan: Option.getOrThrow(decodePlan(task.nextActions)) as NextActionPlan };
  });

describe("Claude Code に手順をやらせる", () => {
  it.effect("頼むと処理中のレーンに出し、やり遂げたら報告を残して手順を済みにし、元のレーンに戻す", () => {
    const h = harness();
    return Effect.gen(function* () {
      const taskId = yield* taskWithPlan([step("s1", "経緯を調べてまとめる", "claude_on_request"), step("s2", "承認する", "human")]);

      yield* startStepRun(taskId, "s1");
      const running = yield* loaded(taskId);
      assert.strictEqual(running.status, "agent_running");
      assert.deepInclude(running.plan.steps[0], { run: { state: "running", at: "2026-11-26T00:00:00.000Z" } });

      yield* h.provide(runStep(taskId, "s1", {}));

      const after = yield* loaded(taskId);
      assert.strictEqual(after.status, "todo");
      assert.deepInclude(after.plan.steps[0], { status: "done", run: { state: "done", summary: "経緯は 11/20 のメールで〜", at: "2026-11-26T00:00:00.000Z" } });
      assert.include(h.requests[0]!.prompt, "経緯を調べてまとめる");
      assert.deepStrictEqual(h.requests[0]!.allowedTools, [...QUESTION_TOOLS]);
      assert.deepStrictEqual(h.requests[0]!.jsonSchema, STEP_JSON_SCHEMA);
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("できなかったら、済みにせずに報告だけ残す", () => {
    const h = harness({ done: false, report: "下書きに要る、先方の名前が分からなかった" });
    return Effect.gen(function* () {
      const taskId = yield* taskWithPlan([step("s1", "返信の下書きを作る", "claude_on_request")]);
      yield* startStepRun(taskId, "s1");
      yield* h.provide(runStep(taskId, "s1", {}));
      assert.deepInclude((yield* loaded(taskId)).plan.steps[0], { status: "todo", run: { state: "failed", summary: "下書きに要る、先方の名前が分からなかった", at: "2026-11-26T00:00:00.000Z" } });
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("人がやる手順や、やっている途中の手順は頼めない", () =>
    Effect.gen(function* () {
      const taskId = yield* taskWithPlan([step("s1", "承認する", "human"), step("s2", "調べる", "claude_on_request")]);
      assert.include((yield* startStepRun(taskId, "s1").pipe(Effect.flip)).message, "Claude Code");
      yield* startStepRun(taskId, "s2");
      assert.include((yield* startStepRun(taskId, "s2").pipe(Effect.flip)).message, "途中");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("自動でやる手順は、番が来ていて、使ってよい Task だけを、一度だけ動かす", () => {
    const h = harness();
    return Effect.gen(function* () {
      const allowed = yield* taskWithPlan([step("s1", "経緯を調べる", "claude_auto"), step("s2", "承認する", "human")]);
      const notYet = yield* taskWithPlan([step("s1", "承認する", "human"), step("s2", "結果を調べる", "claude_auto")]);
      const denied = yield* taskWithPlan([step("s1", "会社の件を調べる", "claude_auto")]);

      yield* h.provide(runAutoSteps({ optionsFor: (taskId) => Effect.succeed(taskId === denied ? undefined : {}) }));
      yield* h.provide(runAutoSteps({ optionsFor: (taskId) => Effect.succeed(taskId === denied ? undefined : {}) }));

      assert.strictEqual(h.requests.length, 1);
      // ユーザーが見ないまま動くので、読んだものを外へ送れる WebFetch を渡さない
      assert.notInclude(h.requests[0]!.allowedTools ?? [], "WebFetch");
      assert.deepInclude((yield* loaded(allowed)).plan.steps[0], { status: "done" });
      assert.isUndefined(((yield* loaded(notYet)).plan.steps[1] as { run?: unknown }).run);
      assert.isUndefined(((yield* loaded(denied)).plan.steps[0] as { run?: unknown }).run);
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("アプリを閉じてやっている途中で止まった手順は、できなかったとして残す", () =>
    Effect.gen(function* () {
      const taskId = yield* taskWithPlan([step("s1", "調べる", "claude_on_request")]);
      yield* startStepRun(taskId, "s1");
      assert.strictEqual(yield* recoverInterruptedStepRuns, 1);
      const run = ((yield* loaded(taskId)).plan.steps[0] as { run?: { state: string; summary?: string } }).run;
      assert.strictEqual(run?.state, "failed");
      assert.include(run?.summary, "閉じられた");
    }).pipe(Effect.provide(TestDatabase)));
});
