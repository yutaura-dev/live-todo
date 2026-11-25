import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { eq } from "drizzle-orm";
import { Database } from "../db/database.js";
import { agentRuns, agentThreads } from "../db/schema.js";
import { TestDatabase } from "../db/test-database.js";
import { SourceItemRepository } from "../source/source-item-repository.js";
import { TaskRepository } from "../task/task-repository.js";
import type { TaskStatus } from "../task/task.js";
import { ClaudeCode, ClaudeCodeError, type ClaudeRequest } from "./claude-code.js";
import { AgentWorkspace } from "./agent-workspace.js";
import { recoverInterruptedAgentRuns, runNextDependencyReview } from "./dependency-triage.js";

const REVIEW = {
  conclusion: "mergeable_after_fix",
  impact: "src/a.ts が影響を受ける",
  requiredChanges: "引数を直す",
  blockers: "",
  configChanges: "",
};

const dependencyTask = (options: { status?: TaskStatus; author?: string; source?: string; state?: "open" | "resolved"; fingerprint?: string; url?: string } = {}) =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const url = options.url ?? "https://github.com/acme/app/pull/42";
    const item = yield* items.upsertItem({
      source: options.source ?? "github:personal",
      externalId: url,
      title: "Update dependency effect to v4（acme/app）",
      url,
      state: options.state ?? "open",
      fingerprint: options.fingerprint ?? "v1",
      author: options.author ?? "renovate[bot]",
    });
    const task = yield* tasks.createTask({ title: item.title, status: options.status ?? "todo" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    return { taskId: task.id, itemExternalId: url };
  });

const statusOf = (taskId: number) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status;
  });

type Recorded = { requests: ClaudeRequest[]; statusDuringRun: TaskStatus[] };

const withAgent = (options: { fail?: string; sessionId?: string; onRun?: Effect.Effect<void, never, TaskRepository | SourceItemRepository> } = {}) => {
  const recorded: Recorded = { requests: [], statusDuringRun: [] };
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const items = yield* SourceItemRepository;
      const claude = ClaudeCode.of({
        run: (request) =>
          Effect.gen(function* () {
            recorded.requests.push(request);
            const all = yield* tasks.listTasks;
            recorded.statusDuringRun.push(...all.map((task) => task.status));
            if (options.onRun) yield* options.onRun.pipe(Effect.provideService(TaskRepository, tasks), Effect.provideService(SourceItemRepository, items));
            if (options.fail) return yield* new ClaudeCodeError({ message: options.fail });
            return { sessionId: options.sessionId ?? "session-1", structured: REVIEW, costUsd: 0.3, permissionDenials: 0 };
          }),
      });
      return yield* effect.pipe(
        Effect.provideService(ClaudeCode, claude),
        Effect.provideService(AgentWorkspace, AgentWorkspace.of({ prepare: (repository, taskId) => Effect.succeed(`/work/${taskId}/${repository}`) })),
      );
    });
  return { recorded, provide };
};

const SOURCES = ["github:personal", "github:personal:watch"];
const run = runNextDependencyReview({ sources: SOURCES, model: "sonnet", maxBudgetUsd: 2 });

describe("runNextDependencyReview", () => {
  it.effect("bot の依存更新 PR を追う Task を、調査中のレーンに移してから claude で調べる", () =>
    Effect.gen(function* () {
      const { taskId } = yield* dependencyTask();
      const agent = withAgent();

      const outcome = yield* agent.provide(run);

      assert.deepStrictEqual(outcome, Option.some({ taskId, succeeded: true }));
      assert.deepStrictEqual(agent.recorded.statusDuringRun, ["agent_running"]);
      const request = agent.recorded.requests[0]!;
      assert.strictEqual(request.cwd, `/work/${taskId}/acme/app`);
      assert.include(request.prompt, "https://github.com/acme/app/pull/42");
      assert.isUndefined(request.resumeSessionId);
      assert.strictEqual(request.model, "sonnet");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("調べ終わったら Todo に戻し、結論を brief に書いて更新マークを付け、結果と session id を残す", () =>
    Effect.gen(function* () {
      const { taskId } = yield* dependencyTask({ status: "needs_review" });

      yield* withAgent().provide(run);

      const tasks = yield* TaskRepository;
      const task = Option.getOrThrow(yield* tasks.findTask(taskId));
      assert.strictEqual(task.status, "todo");
      assert.include(task.brief ?? "", "修正すれば merge 可能");
      const changes = yield* tasks.listChanges(taskId);
      assert.isTrue(changes.some((change) => change.field === "brief" && change.seenAt === null && change.actor === "agent"));
      assert.isFalse(changes.some((change) => change.actor === "user"), "AI の操作をユーザーの判断として記録しない");

      const db = yield* Database;
      const [runRow] = yield* db.select().from(agentRuns).where(eq(agentRuns.taskId, taskId));
      assert.deepInclude(runRow, { status: "succeeded", sessionId: "session-1", previousStatus: "needs_review" });
      assert.deepStrictEqual(runRow?.result, REVIEW);
      const [thread] = yield* db.select().from(agentThreads).where(eq(agentThreads.taskId, taskId));
      assert.deepInclude(thread, { provider: "claude-code", sessionId: "session-1", workspace: `/work/${taskId}/acme/app` });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("PR が更新されたら調べ直し、前回の session を続ける", () =>
    Effect.gen(function* () {
      const { taskId } = yield* dependencyTask();
      yield* withAgent({ sessionId: "session-1" }).provide(run);
      const second = withAgent({ sessionId: "session-2" });

      // 同じ項目を更新するため、Task は作り直さずに項目だけを更新する
      yield* (yield* SourceItemRepository).upsertItem({
        source: "github:personal",
        externalId: "https://github.com/acme/app/pull/42",
        title: "Update dependency effect to v4（acme/app）",
        url: "https://github.com/acme/app/pull/42",
        state: "open",
        fingerprint: "v3",
        author: "renovate[bot]",
      });
      const outcome = yield* second.provide(run);

      assert.deepStrictEqual(Option.map(outcome, (o) => o.taskId), Option.some(taskId));
      assert.strictEqual(second.recorded.requests[0]?.resumeSessionId, "session-1");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("同じ状態の PR は二度調べない（失敗したものも、PR が変わるまでやり直さない）", () =>
    Effect.gen(function* () {
      yield* dependencyTask();
      yield* withAgent({ fail: "落ちた" }).provide(run);

      const again = withAgent();
      assert.isTrue(Option.isNone(yield* again.provide(run)));
      assert.lengthOf(again.recorded.requests, 0);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("失敗したら元のレーンに戻し、理由を残す", () =>
    Effect.gen(function* () {
      const { taskId } = yield* dependencyTask({ status: "needs_review" });

      const outcome = yield* withAgent({ fail: "claude が失敗した（error_max_budget_usd）" }).provide(run);

      assert.deepStrictEqual(outcome, Option.some({ taskId, succeeded: false }));
      assert.strictEqual(yield* statusOf(taskId), "needs_review");
      const [runRow] = yield* (yield* Database).select().from(agentRuns).where(eq(agentRuns.taskId, taskId));
      assert.deepInclude(runRow, { status: "failed", error: "claude が失敗した（error_max_budget_usd）" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("調べている間に同期が状態を変えたら（merge されて完了など）、そちらを優先する", () =>
    Effect.gen(function* () {
      const { taskId } = yield* dependencyTask();
      const agent = withAgent({
        onRun: Effect.gen(function* () {
          yield* (yield* TaskRepository).updateTask(taskId, { status: "done" });
        }),
      });

      yield* agent.provide(run);

      assert.strictEqual(yield* statusOf(taskId), "done");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("bot 以外の PR・ほかのアカウント・手を付けた Task・閉じた PR・PR でない項目は調べない", () =>
    Effect.gen(function* () {
      yield* dependencyTask({ author: "octocat", url: "https://github.com/acme/app/pull/1" });
      yield* dependencyTask({ source: "github:work", url: "https://github.com/acme/app/pull/2" });
      yield* dependencyTask({ status: "in_progress", url: "https://github.com/acme/app/pull/3" });
      yield* dependencyTask({ state: "resolved", url: "https://github.com/acme/app/pull/4" });
      yield* dependencyTask({ url: "https://github.com/acme/app/issues/5" });
      const agent = withAgent();

      assert.isTrue(Option.isNone(yield* agent.provide(run)));
      assert.lengthOf(agent.recorded.requests, 0);
    }).pipe(Effect.provide(TestDatabase)));
});

describe("recoverInterruptedAgentRuns", () => {
  it.effect("途中で止まった調査は失敗として閉じ、Task を元のレーンに戻す", () =>
    Effect.gen(function* () {
      const { taskId } = yield* dependencyTask({ status: "needs_review" });
      const db = yield* Database;
      yield* (yield* TaskRepository).updateTask(taskId, { status: "agent_running" });
      yield* db.insert(agentRuns).values({
        taskId,
        kind: "dependency_review",
        status: "running",
        subjectFingerprint: "v1",
        previousStatus: "needs_review",
        startedAt: "2026-11-25T00:00:00.000Z",
      });

      assert.strictEqual(yield* recoverInterruptedAgentRuns, 1);
      assert.strictEqual(yield* statusOf(taskId), "needs_review");
      const [runRow] = yield* db.select().from(agentRuns).where(eq(agentRuns.taskId, taskId));
      assert.strictEqual(runRow?.status, "failed");
    }).pipe(Effect.provide(TestDatabase)));
});
