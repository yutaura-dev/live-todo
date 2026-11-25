import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { Database } from "../db/database.js";
import { agentRuns } from "../db/schema.js";
import { TestDatabase } from "../db/test-database.js";
import { SourceItemRepository } from "../source/source-item-repository.js";
import { TaskRepository } from "../task/task-repository.js";
import type { TaskStatus } from "../task/task.js";
import { BoardService, TaskNotFoundError } from "./board-service.js";

const run = <A, E>(effect: Effect.Effect<A, E, BoardService | TaskRepository | SourceItemRepository | Database>) =>
  effect.pipe(Effect.provide(BoardService.layer), Effect.provide(TestDatabase));

const taskWithItem = (title: string, status: TaskStatus, judgment?: unknown) =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const item = yield* items.upsertItem({
      source: "github:work",
      externalId: `ext-${title}`,
      title,
      url: `https://github.com/acme/app/issues/${title}`,
      state: "open",
      fingerprint: "v1",
    });
    if (judgment !== undefined) yield* items.setTriage(item.id, "linked", judgment);
    const task = yield* tasks.createTask({ title, status });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    return task;
  });

const columnTitles = (board: { columns: readonly { id: string; cards: readonly { title: string }[] }[] }) =>
  Object.fromEntries(board.columns.map((column) => [column.id, column.cards.map((card) => card.title)]));

describe("BoardService.board", () => {
  it.effect("要確認・todo・進行中・完了の列に、ステータスごとに Task を並べ、dismissed と archived は出さない", () =>
    run(
      Effect.gen(function* () {
        yield* taskWithItem("a", "needs_review");
        yield* taskWithItem("g", "agent_running");
        yield* taskWithItem("b", "todo");
        yield* taskWithItem("c", "in_progress");
        yield* taskWithItem("d", "done");
        yield* taskWithItem("e", "dismissed");
        yield* taskWithItem("f", "archived");

        const board = yield* (yield* BoardService).board;

        assert.deepStrictEqual(columnTitles(board), { needs_review: ["a"], agent_running: ["g"], todo: ["b"], in_progress: ["c"], done: ["d"] });
      }),
    ));

  it.effect("カードに、元の項目の URL・Source・判定の理由と確率・更新マークの数を出す", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "needs_review", { verdict: "needs_review", method: "decisions", probability: 0.42 });
        yield* (yield* TaskRepository).recordChange(task.id, { kind: "field_changed", field: "status", before: "todo", after: "needs_review", unread: true });

        const board = yield* (yield* BoardService).board;

        assert.deepInclude(board.columns[0]?.cards[0], {
          id: task.id,
          url: "https://github.com/acme/app/issues/a",
          source: "github:work",
          judgment: { method: "decisions", probability: 0.42 },
          unreadChanges: 1,
        });
      }),
    ));

  it.effect("列の中は、更新マークがあるものを先に、次に新しく更新されたものを先に並べる", () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
        yield* taskWithItem("old", "todo");
        yield* TestClock.setTime(Date.parse("2026-11-25T01:00:00Z"));
        yield* taskWithItem("new", "todo");
        const marked = yield* taskWithItem("marked", "todo");
        yield* TestClock.setTime(Date.parse("2026-11-24T00:00:00Z"));
        yield* (yield* TaskRepository).recordChange(marked.id, { kind: "field_changed", field: "status", before: "done", after: "todo", unread: true });

        const board = yield* (yield* BoardService).board;

        assert.deepStrictEqual(columnTitles(board)["todo"], ["marked", "new", "old"]);
      }),
    ));
});

describe("BoardService.moveTask", () => {
  it.effect("Task を別の列に動かすと、ユーザーの操作として記録し、更新マークは付けない", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "needs_review");

        yield* (yield* BoardService).moveTask(task.id, "dismissed");

        const tasks = yield* TaskRepository;
        const last = (yield* tasks.listChanges(task.id)).at(-1)!;
        assert.strictEqual((yield* tasks.listTasks)[0]?.status, "dismissed");
        assert.deepInclude(last, { field: "status", before: "needs_review", after: "dismissed", actor: "user", seenAt: last.occurredAt });
      }),
    ));

  it.effect("同じ列に動かしたときは何も記録しない", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "todo");

        yield* (yield* BoardService).moveTask(task.id, "todo");

        assert.deepStrictEqual(yield* (yield* TaskRepository).listChanges(task.id), []);
      }),
    ));

  it.effect("存在しない Task を動かそうとしたらエラーにする", () =>
    run(
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* BoardService).moveTask(999, "todo"));

        assert.instanceOf(error, TaskNotFoundError);
      }),
    ));
});

describe("BoardService.markSeen", () => {
  it.effect("カードを開いたら、その Task の更新マークを消す", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "todo");
        yield* (yield* TaskRepository).recordChange(task.id, { kind: "field_changed", field: "status", before: "done", after: "todo", unread: true });

        yield* (yield* BoardService).markSeen(task.id);

        const board = yield* (yield* BoardService).board;
        assert.strictEqual(board.columns.find((column) => column.id === "todo")?.cards[0]?.unreadChanges, 0);
      }),
    ));
});

describe("BoardService.taskDetail", () => {
  it.effect("Task に紐づいた元の項目を、役割と判定の結果つきで返す", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "todo", { method: "decisions", probability: 0.7 });
        const items = yield* SourceItemRepository;
        const related = yield* items.upsertItem({
          source: "slack:work",
          externalId: "thread-1",
          title: "関連するスレッド",
          url: "https://example.slack.com/archives/C1/p1",
          state: "open",
          fingerprint: "v1",
        });
        yield* (yield* TaskRepository).linkItem(task.id, related.id, "context");

        const detail = yield* (yield* BoardService).taskDetail(task.id);

        assert.deepStrictEqual(
          detail.items.map((item) => ({ role: item.role, source: item.source, title: item.title, judgment: item.judgment })),
          [
            { role: "tracks", source: "github:work", title: "a", judgment: { method: "decisions", probability: 0.7 } },
            { role: "context", source: "slack:work", title: "関連するスレッド", judgment: undefined },
          ],
        );
      }),
    ));

  it.effect("変更の履歴を新しい順に、誰が変えたかと未読かどうかつきで返す", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "needs_review");
        const tasks = yield* TaskRepository;
        yield* tasks.recordChange(task.id, { kind: "field_changed", field: "title", before: "a", after: "b", unread: true });
        yield* TestClock.adjust("1 minute");
        yield* (yield* BoardService).moveTask(task.id, "todo");

        const detail = yield* (yield* BoardService).taskDetail(task.id);

        assert.deepStrictEqual(
          detail.changes.map(({ field, before, after, actor, unread }) => ({ field, before, after, actor, unread })),
          [
            { field: "status", before: "needs_review", after: "todo", actor: "user", unread: false },
            { field: "title", before: "a", after: "b", actor: "sync", unread: true },
          ],
        );
        assert.strictEqual(detail.status, "todo");
      }),
    ));

  it.effect("存在しない Task なら TaskNotFoundError にする", () =>
    run(
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* BoardService).taskDetail(999));

        assert.instanceOf(error, TaskNotFoundError);
      }),
    ));
});

describe("AI の調査", () => {
  it.effect("カードに brief（今の状況）を出す", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "todo");
        yield* (yield* TaskRepository).updateTask(task.id, { brief: "依存更新の調査: merge 可能" });

        const board = yield* (yield* BoardService).board;

        assert.strictEqual(board.columns.find((column) => column.id === "todo")?.cards[0]?.brief, "依存更新の調査: merge 可能");
      }),
    ));

  it.effect("詳細には、最後の調査の状態・結果・session id を出す", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "todo");
        const db = yield* Database;
        const base = { taskId: task.id, kind: "dependency_review", subjectFingerprint: "v1", previousStatus: "todo", startedAt: "2026-11-25T00:00:00.000Z" };
        yield* db.insert(agentRuns).values({ ...base, status: "failed", error: "落ちた" });
        yield* db.insert(agentRuns).values({ ...base, status: "succeeded", result: { conclusion: "mergeable" }, sessionId: "s-2", costUsd: "0.4", finishedAt: "2026-11-25T00:05:00.000Z" });

        const detail = yield* (yield* BoardService).taskDetail(task.id);

        assert.deepInclude(detail.agentRun, { kind: "dependency_review", status: "succeeded", result: { conclusion: "mergeable" }, sessionId: "s-2", costUsd: 0.4 });
      }),
    ));

  it.effect("AI が調査中のレーンのカードには、調査待ちか調べている最中かと、待ちの順番を出す", () =>
    run(
      Effect.gen(function* () {
        const running = yield* taskWithItem("a", "agent_running");
        const waitingFirst = yield* taskWithItem("b", "agent_running");
        const waitingSecond = yield* taskWithItem("c", "agent_running");
        const db = yield* Database;
        const base = { kind: "dependency_review", subjectFingerprint: "v1", previousStatus: "todo", startedAt: "2026-11-25T00:00:00.000Z" };
        yield* db.insert(agentRuns).values({ ...base, taskId: waitingFirst.id, status: "queued" });
        yield* db.insert(agentRuns).values({ ...base, taskId: running.id, status: "running" });
        yield* db.insert(agentRuns).values({ ...base, taskId: waitingSecond.id, status: "queued" });

        const board = yield* (yield* BoardService).board;
        const cards = board.columns.find((column) => column.id === "agent_running")?.cards ?? [];
        const stateOf = (id: number) => cards.find((card) => card.id === id)?.agent;

        assert.deepStrictEqual(stateOf(running.id), { state: "running" });
        assert.deepStrictEqual(stateOf(waitingFirst.id), { state: "queued", position: 1 });
        assert.deepStrictEqual(stateOf(waitingSecond.id), { state: "queued", position: 2 });
      }),
    ));

  it.effect("最後の調べ直しが失敗していたら、成功した調査の結果を出し、失敗は添えるだけにする", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "todo");
        const db = yield* Database;
        const base = { taskId: task.id, kind: "dependency_review", subjectFingerprint: "v1", previousStatus: "todo", startedAt: "2026-11-25T00:00:00.000Z" };
        yield* db.insert(agentRuns).values({ ...base, status: "succeeded", result: { conclusion: "mergeable" } });
        yield* db.insert(agentRuns).values({ ...base, status: "failed", error: "作業場所を取得できない" });

        const detail = yield* (yield* BoardService).taskDetail(task.id);

        assert.deepInclude(detail.agentRun, { status: "succeeded", result: { conclusion: "mergeable" } });
        assert.strictEqual(detail.agentRunProblem, "作業場所を取得できない");
      }),
    ));

  it.effect("調べたことがなければ、調査の結果は出さない", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "todo");

        assert.isUndefined((yield* (yield* BoardService).taskDetail(task.id)).agentRun);
      }),
    ));
});

describe("次にやること", () => {
  const plan = {
    steps: [
      { id: "fix", kind: "fix_and_push", title: "修正を行い、PR に push する", effort: "normal", mode: "serial", status: "todo" },
      { id: "merge", kind: "merge_pull_request", title: "PR を merge する", effort: "easy", mode: "serial", status: "todo" },
    ],
  };

  it.effect("カードには、いま着手できる手順と手間を出す", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "todo");
        yield* (yield* TaskRepository).updateTask(task.id, { nextActions: plan });

        const board = yield* (yield* BoardService).board;

        assert.deepStrictEqual(board.columns.find((column) => column.id === "todo")?.cards[0]?.nextActions, [
          { title: "修正を行い、PR に push する", effort: "normal" },
        ]);
      }),
    ));

  it.effect("Todo のレーンは、いま着手できる手順の手間が少ない順に並べ、次にやることがない Task は最後にする", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const step = (id: string, effort: string, mode = "serial") => ({ id, kind: "manual", title: id, effort, mode, status: "todo" });
        const hard = yield* taskWithItem("hard", "todo");
        yield* tasks.updateTask(hard.id, { nextActions: { steps: [step("h", "hard")] } });
        yield* taskWithItem("none", "todo");
        const parallelEasy = yield* taskWithItem("parallel", "todo");
        // 直列の先頭は難しいが、並列でできる簡単な手順があるので「簡単」
        yield* tasks.updateTask(parallelEasy.id, { nextActions: { steps: [step("p1", "tedious"), step("p2", "easy", "parallel")] } });
        const normal = yield* taskWithItem("normal", "todo");
        yield* tasks.updateTask(normal.id, { nextActions: { steps: [step("n", "normal"), step("n2", "easy")] } });

        const board = yield* (yield* BoardService).board;

        assert.deepStrictEqual(board.columns.find((column) => column.id === "todo")?.cards.map((card) => card.title), [
          "parallel",
          "normal",
          "hard",
          "none",
        ]);
        assert.strictEqual(board.columns.find((column) => column.id === "todo")?.cards[0]?.effort, "easy");
      }),
    ));

  it.effect("手順を済ませると次の手順に進み、詳細には手順の並び全体を返す", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "todo");
        yield* (yield* TaskRepository).updateTask(task.id, { nextActions: plan });
        const service = yield* BoardService;

        yield* service.completeStep(task.id, "fix");

        const detail = yield* service.taskDetail(task.id);
        assert.deepStrictEqual(detail.nextActions?.steps.map((step) => step.status), ["done", "todo"]);
        assert.deepStrictEqual(detail.currentStepIds, ["merge"]);
      }),
    ));

  it.effect("分かれ道を選ぶと、選んだ側の手順に進む", () =>
    run(
      Effect.gen(function* () {
        const task = yield* taskWithItem("a", "todo");
        yield* (yield* TaskRepository).updateTask(task.id, {
          nextActions: {
            steps: [
              {
                id: "decide",
                kind: "decision",
                title: "決める",
                effort: "easy",
                mode: "serial",
                status: "todo",
                options: [{ key: "as_is", label: "そのまま", steps: [{ id: "as_is.merge", kind: "merge_pull_request", title: "PR を merge する", effort: "easy", mode: "serial", status: "todo" }] }],
              },
            ],
          },
        });
        const service = yield* BoardService;

        yield* service.chooseOption(task.id, "decide", "as_is");

        const board = yield* service.board;
        assert.deepStrictEqual(board.columns.find((column) => column.id === "todo")?.cards[0]?.nextActions, [{ title: "PR を merge する", effort: "easy" }]);
      }),
    ));
});
