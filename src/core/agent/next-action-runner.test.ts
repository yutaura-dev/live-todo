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
import { requestReplan, runNextActionPlanning } from "./next-action-runner.js";

const NONE = { kind: "none" as const, repository: "", query: "", pullUrl: "" };

const NO_RECURRING = { suggest: false, day: 1, leadDays: 0, title: "", note: "", reason: "" };
const PROPOSAL = { steps: [{ title: "Slack で状況を聞く", type: "manual", until: NONE, effort: "easy", mode: "serial", options: [] }], recurring: NO_RECURRING };

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

const withAgent = (options: { fail?: string; proposals?: Record<number, unknown> } = {}) => {
  const requests: ClaudeRequest[] = [];
  const contexts: Record<string, string>[] = [];
  const statusesDuringRun: TaskStatus[][] = [];
  const prepared: Array<{ repository: string; pullUrl: string }> = [];
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
                const taskId = Number(/task-(\d+)/.exec(request.cwd)?.[1]);
                return { sessionId: "plan-session", structured: options.proposals?.[taskId] ?? PROPOSAL, costUsd: 0.05, permissionDenials: 0 };
              }),
          }),
        ),
        Effect.provideService(
          AgentWorkspace,
          AgentWorkspace.of({
            prepare: (repository, taskId, pullUrl) =>
              Effect.sync(() => {
                prepared.push({ repository, pullUrl });
                return { cwd: `/work/task-${taskId}/repo/${repository}`, contextDir: `/work/task-${taskId}/context`, headSha: "h" };
              }),
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
  return { requests, contexts, statusesDuringRun, prepared, provide };
};

const run = runNextActionPlanning({ sources: ["github:personal", "github:personal:watch"], concurrency: 2 });

const nextActionsOf = (taskId: number) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).nextActions as { steps: { title: string }[] } | null;
  });

describe("runNextActionPlanning（元の項目の本文）", () => {
  it.effect("メールの本文など、足して渡すファイルがあれば task.json と一緒に渡す（取れなければ渡さずに考えさせる）", () =>
    Effect.gen(function* () {
      const first = yield* task();
      const agent = withAgent();

      yield* agent.provide(
        runNextActionPlanning({
          sources: ["github:personal"],
          concurrency: 1,
          extraContext: (taskId) => (taskId === first ? Effect.succeed({ "mail.json": "[{\"subject\":\"権限の更新\"}]" }) : Effect.fail("取れない")),
        }),
      );

      assert.strictEqual(agent.contexts[0]!["mail.json"], "[{\"subject\":\"権限の更新\"}]");
      assert.include(agent.requests[0]!.prompt, "mail.json");
    }).pipe(Effect.provide(TestDatabase)));
});

describe("runNextActionPlanning（PR の Task）", () => {
  it.effect("PR を追う Task には、PR の今の状態を集めて渡す（確認する手順を作らせないため）", () =>
    Effect.gen(function* () {
      yield* task({ url: "https://github.com/acme/app/pull/713" });
      const agent = withAgent();

      yield* agent.provide(run);

      assert.deepInclude(JSON.parse(agent.contexts[0]!["pr-state.json"]!), { url: "https://github.com/acme/app/pull/713", reviewDecision: "REVIEW_REQUIRED" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("PR のリポジトリを用意して作業ディレクトリにし、そのプロジェクトの手順（deploy など）を読み取れるようにする", () =>
    Effect.gen(function* () {
      yield* task({ url: "https://github.com/acme/app/pull/713" });
      const agent = withAgent();

      yield* agent.provide(run);

      assert.deepStrictEqual(agent.prepared, [{ repository: "acme/app", pullUrl: "https://github.com/acme/app/pull/713" }]);
      assert.match(agent.requests[0]?.cwd ?? "", /\/repo\/acme\/app$/);
      assert.include([...(agent.requests[0]?.addDirs ?? [])], agent.requests[0]?.cwd.replace(/\/repo\/acme\/app$/, "/context"));
      assert.include(agent.requests[0]?.prompt ?? "", ".github/workflows");
    }).pipe(Effect.provide(TestDatabase)));
});

describe("定期の Task の提案", () => {
  it.effect("AI が定期の Task にした方がよいと提案したら、その提案を Task に残す。提案しなければ残さない", () =>
    Effect.gen(function* () {
      const suggested = yield* task({ url: "https://github.com/acme/app/issues/1" });
      const plain = yield* task({ url: "https://github.com/acme/app/issues/2" });
      const recurring = { suggest: true, day: 1, leadDays: 3, title: "請求書を送る", note: "金額は前月と同じ", reason: "毎月初めに送ると書かれている" };
      const agent = withAgent({ proposals: { [suggested]: { ...PROPOSAL, recurring }, [plain]: PROPOSAL } });

      yield* agent.provide(run);

      const tasks = yield* TaskRepository;
      assert.deepStrictEqual(Option.getOrThrow(yield* tasks.findTask(suggested)).recurringSuggestion, {
        day: 1,
        leadDays: 3,
        title: "請求書を送る",
        note: "金額は前月と同じ",
        reason: "毎月初めに送ると書かれている",
      });
      assert.isNull(Option.getOrThrow(yield* tasks.findTask(plain)).recurringSuggestion);
    }).pipe(Effect.provide(TestDatabase)));
});

describe("requestReplan（次にやることを考え直す）", () => {
  it.effect("済んだ手順を残して、残りだけを考え直させる（済んだ手順を AI に伝える）", () =>
    Effect.gen(function* () {
      const taskId = yield* task({
        nextActions: {
          steps: [
            { id: "s1", kind: "manual", title: "見た目を見直す", effort: "hard", mode: "serial", status: "done" },
            { id: "s2", kind: "manual", title: "古い手順", effort: "easy", mode: "serial", status: "todo" },
          ],
        },
      });
      const agent = withAgent();

      yield* requestReplan(taskId);
      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "agent_running");
      yield* agent.provide(run);

      assert.deepInclude(JSON.parse(agent.contexts[0]!["task.json"]!), { doneSteps: ["見た目を見直す"] });
      assert.include(agent.requests[0]?.prompt ?? "", "済んだ手順");
      const steps = (yield* nextActionsOf(taskId))?.steps as Array<{ title: string; status: string }>;
      assert.deepStrictEqual(
        steps.map((step) => [step.title, step.status]),
        [
          ["見た目を見直す", "done"],
          ["Slack で状況を聞く", "todo"],
        ],
      );
      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "todo");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("ユーザーの希望（こうしたい）を伝えると、今の残りの手順と希望を AI に渡して、それに合わせて書き換えさせる", () =>
    Effect.gen(function* () {
      const taskId = yield* task({
        nextActions: { steps: [{ id: "s1", kind: "manual", title: "請求書を確かめる", effort: "easy", mode: "serial", status: "todo" }] },
      });
      const agent = withAgent();

      yield* requestReplan(taskId, "  このメールはアーカイブして終わりにしたい ");
      yield* agent.provide(run);

      const context = JSON.parse(agent.contexts[0]!["task.json"]!);
      assert.deepInclude(context, { remainingSteps: ["請求書を確かめる"], request: "このメールはアーカイブして終わりにしたい" });
      assert.include(agent.requests[0]?.prompt ?? "", "このメールはアーカイブして終わりにしたい");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("処理中の Task は考え直さない", () =>
    Effect.gen(function* () {
      const taskId = yield* task({ status: "agent_running", nextActions: { steps: [] } });

      const error = yield* requestReplan(taskId).pipe(Effect.flip);

      assert.include(error.message, "処理中");
    }).pipe(Effect.provide(TestDatabase)));
});

describe("runNextActionPlanning", () => {
  it.effect("PR でない Task では、リポジトリを用意しない", () =>
    Effect.gen(function* () {
      yield* task();
      const agent = withAgent();

      yield* agent.provide(run);

      assert.lengthOf(agent.prepared, 0);
      assert.strictEqual(agent.requests[0]?.cwd, agent.requests[0]?.cwd.replace(/\/repo\/.*$/, ""));
    }).pipe(Effect.provide(TestDatabase)));

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

  it.effect("claude には集めた情報のフォルダを読ませ、手順の開く先を確かめるための Web の検索だけを足す（リポジトリは渡さない）", () =>
    Effect.gen(function* () {
      yield* task();
      const agent = withAgent();

      yield* agent.provide(run);

      const request = agent.requests[0]!;
      assert.match(request.cwd, /\/context$/);
      assert.deepStrictEqual([...request.allowedTools], ["Read", "Grep", "Glob", "WebSearch"]);
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
