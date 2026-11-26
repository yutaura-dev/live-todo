import { assert, describe, it } from "@effect/vitest";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { ClaudeCode, ClaudeCodeError, type ClaudeRequest } from "../core/agent/claude-code.js";
import { ConflictWorkspace, ConflictWorkspaceError } from "../core/agent/conflict-workspace.js";
import { Database } from "../core/db/database.js";
import { agentRuns, approvals } from "../core/db/schema.js";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { conflictPlan, currentSteps, decodePlan } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { finishConflictResolution, pushConflictResolution, startConflictResolution } from "./conflict-resolution-flow.js";

const RESOLUTION = { summary: "両方の設定を残した", files: [{ path: "a.json", resolution: "キーを足し合わせた" }], concerns: "" };

const conflictTask = Effect.gen(function* () {
  const items = yield* SourceItemRepository;
  const tasks = yield* TaskRepository;
  const item = yield* items.upsertItem({
    source: "github:personal:watch",
    externalId: "https://api.github.com/repos/acme/app/pulls/4#pr-conflict",
    title: "PR #4 の conflict を解消する",
    url: "https://github.com/acme/app/pull/4",
    state: "open",
    fingerprint: "v1",
  });
  const task = yield* tasks.createTask({ title: item.title, status: "todo" });
  yield* tasks.linkItem(task.id, item.id, "tracks");
  yield* tasks.updateTask(task.id, { nextActions: conflictPlan() });
  return task.id;
});

const doubles = (options: { claudeFails?: boolean; commitFails?: string; pushFails?: string } = {}) => {
  const requests: ClaudeRequest[] = [];
  const pushes: Array<{ cwd: string; headRef: string; expectedHeadSha: string; commitSha: string; token: string }> = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        ClaudeCode,
        ClaudeCode.of({
          run: (request) => {
            requests.push(request);
            return options.claudeFails
              ? Effect.fail(new ClaudeCodeError({ message: "落ちた" }))
              : Effect.succeed({ sessionId: "conflict-session", structured: RESOLUTION, costUsd: 0.1, permissionDenials: 0 });
          },
        }),
      ),
      Effect.provideService(
        ConflictWorkspace,
        ConflictWorkspace.of({
          prepare: (taskId, pullUrl) =>
            Effect.succeed({
              cwd: `/w/task-${taskId}/conflict`,
              repository: "acme/app",
              headRef: "feature/x",
              baseRef: "main",
              headSha: "a".repeat(40),
              conflicted: pullUrl.endsWith("/4") ? ["a.json"] : [],
              isolationDir: `/w/task-${taskId}/no-credentials`,
              cacheDir: `/w/task-${taskId}/package-cache`,
            }),
          commit: () =>
            options.commitFails === undefined
              ? Effect.succeed({ commitSha: "b".repeat(40), diff: "diff --git a/a.json b/a.json" })
              : Effect.fail(new ConflictWorkspaceError({ message: options.commitFails })),
          push: (cwd, _repository, headRef, expectedHeadSha, commitSha, token) =>
            Effect.suspend(() => {
              pushes.push({ cwd, headRef, expectedHeadSha, commitSha, token });
              return options.pushFails === undefined ? Effect.void : Effect.fail(new ConflictWorkspaceError({ message: options.pushFails }));
            }),
        }),
      ),
    );
  return { requests, pushes, provide };
};

const taskOf = (taskId: number) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId));
  });
const currentKinds = (taskId: number) =>
  Effect.gen(function* () {
    return currentSteps(Option.getOrThrow(decodePlan((yield* taskOf(taskId)).nextActions))).map((step) => step.kind);
  });
const tokenFor = (accountId: string) => Effect.succeed(`token-of-${accountId}`);

describe("コンフリクトを直す", () => {
  it.effect("始めると処理中のレーンに移し、Claude Code にコンフリクトしたファイルだけを直させ、手元で commit して push の確認に進める", () =>
    Effect.gen(function* () {
      const taskId = yield* conflictTask;
      const agent = doubles();

      const runId = yield* startConflictResolution(taskId);
      assert.strictEqual((yield* taskOf(taskId)).status, "agent_running");
      yield* agent.provide(finishConflictResolution(runId, { model: "sonnet", maxBudgetUsd: 2 }));

      assert.strictEqual(agent.requests[0]?.cwd, `/w/task-${taskId}/conflict`);
      assert.include(agent.requests[0]?.prompt ?? "", "a.json");
      assert.deepStrictEqual([...(agent.requests[0]?.allowedTools ?? [])], ["Read", "Edit", "Grep", "Glob"]);
      assert.strictEqual((yield* taskOf(taskId)).status, "todo");
      assert.deepStrictEqual(yield* currentKinds(taskId), ["push_conflict_resolution"]);
      const [run] = yield* (yield* Database).select().from(agentRuns).where(eq(agentRuns.id, runId));
      assert.strictEqual(run?.status, "succeeded");
      assert.strictEqual(run?.subjectSha, "a".repeat(40));
      assert.deepInclude(run?.result as object, { diff: "diff --git a/a.json b/a.json", headRef: "feature/x", commitSha: "b".repeat(40) });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("直せなかったら（印が残った・ほかのファイルを変えた・AI が失敗した）、元のレーンに戻して理由を更新マークで知らせる", () =>
    Effect.gen(function* () {
      const taskId = yield* conflictTask;
      const agent = doubles({ commitFails: "コンフリクトの印が残っている: a.json" });

      yield* agent.provide(finishConflictResolution(yield* startConflictResolution(taskId), {}));

      assert.strictEqual((yield* taskOf(taskId)).status, "todo");
      assert.deepStrictEqual(yield* currentKinds(taskId), ["resolve_conflicts"]);
      const last = (yield* (yield* TaskRepository).listChanges(taskId)).at(-1);
      assert.include(String(last?.after), "コンフリクトの印が残っている");
      assert.isNull(last?.seenAt);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("AI が失敗しても、元のレーンに戻して直す手順のままにする", () =>
    Effect.gen(function* () {
      const taskId = yield* conflictTask;

      yield* doubles({ claudeFails: true }).provide(finishConflictResolution(yield* startConflictResolution(taskId), {}));

      assert.strictEqual((yield* taskOf(taskId)).status, "todo");
      assert.deepStrictEqual(yield* currentKinds(taskId), ["resolve_conflicts"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("同じ Task で直している最中なら、もう一度は始めない", () =>
    Effect.gen(function* () {
      const taskId = yield* conflictTask;
      yield* startConflictResolution(taskId);

      const again = yield* startConflictResolution(taskId).pipe(Effect.flip);
      assert.include(again.message, "直している最中");
    }).pipe(Effect.provide(TestDatabase)));
});

describe("直した内容を push する", () => {
  it.effect("承認を記録し、直す前の head から動いていないことを確かめたうえで、アカウントのトークンで PR のブランチに push する", () =>
    Effect.gen(function* () {
      const taskId = yield* conflictTask;
      const agent = doubles();
      yield* agent.provide(finishConflictResolution(yield* startConflictResolution(taskId), {}));

      yield* agent.provide(pushConflictResolution(taskId, "b".repeat(40), tokenFor));

      assert.deepStrictEqual(agent.pushes, [
        { cwd: `/w/task-${taskId}/conflict`, headRef: "feature/x", expectedHeadSha: "a".repeat(40), commitSha: "b".repeat(40), token: "token-of-personal" },
      ]);
      assert.deepStrictEqual(yield* currentKinds(taskId), []);
      const [approval] = yield* (yield* Database).select().from(approvals).where(eq(approvals.taskId, taskId));
      assert.deepInclude(approval, { action: "push_conflict_resolution", target: "acme/app#4", status: "executed" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("push に失敗したら、失敗を記録して手順は進めない", () =>
    Effect.gen(function* () {
      const taskId = yield* conflictTask;
      const agent = doubles({ pushFails: "PR のブランチが進んでいる" });
      yield* agent.provide(finishConflictResolution(yield* startConflictResolution(taskId), {}));

      const error = yield* agent.provide(pushConflictResolution(taskId, "b".repeat(40), tokenFor)).pipe(Effect.flip);

      assert.include(error.message, "PR のブランチが進んでいる");
      assert.deepStrictEqual(yield* currentKinds(taskId), ["push_conflict_resolution"]);
      const [approval] = yield* (yield* Database)
        .select()
        .from(approvals)
        .where(and(eq(approvals.taskId, taskId), eq(approvals.status, "failed")));
      assert.isDefined(approval);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("確認画面で見せた commit が、最新の直した記録と違えば push しない（見ていない内容を push しない）", () =>
    Effect.gen(function* () {
      const taskId = yield* conflictTask;
      const agent = doubles();
      yield* agent.provide(finishConflictResolution(yield* startConflictResolution(taskId), {}));

      const error = yield* agent.provide(pushConflictResolution(taskId, "c".repeat(40), tokenFor)).pipe(Effect.flip);

      assert.include(error.message, "もう一度確かめて");
      assert.lengthOf(agent.pushes, 0);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("直した記録がなければ push しない", () =>
    Effect.gen(function* () {
      const taskId = yield* conflictTask;
      const agent = doubles();

      const error = yield* agent.provide(pushConflictResolution(taskId, "b".repeat(40), tokenFor)).pipe(Effect.flip);

      assert.include(error.message, "直した記録がない");
      assert.lengthOf(agent.pushes, 0);
    }).pipe(Effect.provide(TestDatabase)));
});
