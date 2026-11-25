import { assert, describe, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Database } from "../db/database.js";
import { agentRuns } from "../db/schema.js";
import { TestDatabase } from "../db/test-database.js";
import { SourceItemRepository } from "../source/source-item-repository.js";
import { TaskRepository } from "../task/task-repository.js";
import type { TaskStatus } from "../task/task.js";
import { AgentWorkspace } from "./agent-workspace.js";
import { ClaudeCode, ClaudeCodeError, type ClaudeRequest } from "./claude-code.js";
import { runNextActionPlanning } from "./next-action-runner.js";

const PROPOSAL = { steps: [{ title: "Slack で状況を聞く", type: "manual", effort: "easy", mode: "serial", options: [] }] };

const task = (options: { status?: TaskStatus; author?: string; source?: string; url?: string; nextActions?: unknown } = {}) =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const url = options.url ?? "https://github.com/acme/app/issues/7";
    const item = yield* items.upsertItem({
      source: options.source ?? "github:personal",
      externalId: url,
      title: "障害の調査依頼（acme/app）",
      url,
      state: "open",
      fingerprint: "v1",
      ...(options.author === undefined ? {} : { author: options.author }),
    });
    yield* items.setTriage(item.id, "linked", { verdict: "todo", method: "structured", request: { input: "本文: ログを見てほしい" } });
    const created = yield* tasks.createTask({ title: item.title, status: options.status ?? "todo" });
    yield* tasks.linkItem(created.id, item.id, "tracks");
    if (options.nextActions !== undefined) yield* tasks.updateTask(created.id, { nextActions: options.nextActions });
    return created.id;
  });

const withAgent = (options: { fail?: string } = {}) => {
  const requests: ClaudeRequest[] = [];
  const contexts: Record<string, string>[] = [];
  const statusesDuringRun: TaskStatus[][] = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      return yield* effect.pipe(
        Effect.provideService(
          ClaudeCode,
          ClaudeCode.of({
            run: (request) =>
              Effect.gen(function* () {
                requests.push(request);
                statusesDuringRun.push((yield* tasks.listTasks).map((t) => t.status));
                if (options.fail) return yield* new ClaudeCodeError({ message: options.fail });
                return { sessionId: "plan-session", structured: PROPOSAL, costUsd: 0.05, permissionDenials: 0 };
              }),
          }),
        ),
        Effect.provideService(
          AgentWorkspace,
          AgentWorkspace.of({
            prepare: () => Effect.die(new Error("リポジトリは要らない")),
            pullRequestState: (url) => Effect.succeed(JSON.stringify({ url, author: "me", reviewDecision: "REVIEW_REQUIRED" })),
            writeContext: (taskId, files) =>
              Effect.sync(() => {
                contexts.push(files);
                return `/work/task-${taskId}/context`;
              }),
          }),
        ),
      );
    });
  return { requests, contexts, statusesDuringRun, provide };
};

const run = runNextActionPlanning({ sources: ["github:personal", "github:personal:watch"], concurrency: 2 });

const nextActionsOf = (taskId: number) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).nextActions as { steps: { title: string }[] } | null;
  });

describe("runNextActionPlanning（PR の Task）", () => {
  it.effect("PR を追う Task には、PR の今の状態を集めて渡す（確認する手順を作らせないため）", () =>
    Effect.gen(function* () {
      yield* task({ url: "https://github.com/acme/app/pull/713" });
      const agent = withAgent();

      yield* agent.provide(run);

      assert.deepInclude(JSON.parse(agent.contexts[0]!["pr-state.json"]!), { url: "https://github.com/acme/app/pull/713", reviewDecision: "REVIEW_REQUIRED" });
    }).pipe(Effect.provide(TestDatabase)));
});

describe("runNextActionPlanning", () => {
  it.effect("次にやることがない Task を調査中のレーンに入れて claude に考えさせ、手順を保存して元のレーンに戻す", () =>
    Effect.gen(function* () {
      const taskId = yield* task({ status: "needs_review" });
      const agent = withAgent();

      const outcome = yield* agent.provide(run);

      assert.deepStrictEqual(outcome, [{ taskId, succeeded: true }]);
      assert.deepStrictEqual(agent.statusesDuringRun, [["agent_running"]]);
      assert.deepStrictEqual((yield* nextActionsOf(taskId))?.steps.map((step) => step.title), ["Slack で状況を聞く"]);
      const tasks = yield* TaskRepository;
      assert.strictEqual(Option.getOrThrow(yield* tasks.findTask(taskId)).status, "needs_review");
      const changes = yield* tasks.listChanges(taskId);
      assert.isTrue(changes.some((change) => change.field === "next_actions" && change.seenAt === null && change.actor === "agent"));
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("claude には集めた情報のフォルダだけを読ませる（リポジトリは渡さない）", () =>
    Effect.gen(function* () {
      yield* task();
      const agent = withAgent();

      yield* agent.provide(run);

      const request = agent.requests[0]!;
      assert.match(request.cwd, /\/context$/);
      assert.deepStrictEqual([...request.allowedTools], ["Read", "Grep", "Glob"]);
      assert.isUndefined(agent.contexts[0]!["pr-state.json"], "PR でない項目には PR の状態を集めない");
      const context = JSON.parse(agent.contexts[0]!["task.json"]!);
      assert.strictEqual(context.title, "障害の調査依頼（acme/app）");
      assert.deepInclude(context.items[0], { url: "https://github.com/acme/app/issues/7", collected: "本文: ログを見てほしい" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("次にやることがある Task・依存更新の bot の PR・ほかのアカウント・終わった Task は対象にしない", () =>
    Effect.gen(function* () {
      yield* task({ nextActions: { steps: [] }, url: "https://github.com/acme/app/issues/1" });
      yield* task({ author: "renovate[bot]", url: "https://github.com/acme/app/pull/2" });
      yield* task({ source: "github:work", url: "https://github.com/acme/app/issues/3" });
      yield* task({ status: "done", url: "https://github.com/acme/app/issues/4" });
      const agent = withAgent();

      assert.lengthOf(yield* agent.provide(run), 0);
      assert.lengthOf(agent.requests, 0);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("失敗したら元のレーンに戻し、1 時間あけるまで調べ直さない", () =>
    Effect.gen(function* () {
      const taskId = yield* task();

      assert.deepStrictEqual(yield* withAgent({ fail: "落ちた" }).provide(run), [{ taskId, succeeded: false }]);
      const [failed] = yield* (yield* Database).select().from(agentRuns).where(eq(agentRuns.taskId, taskId));
      assert.deepInclude(failed, { kind: "next_actions", status: "failed" });
      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "todo");
      assert.lengthOf(yield* withAgent().provide(run), 0);
    }).pipe(Effect.provide(TestDatabase)));
});
