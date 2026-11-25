import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../db/test-database.js";
import { SourceItemRepository } from "../source/source-item-repository.js";
import { TaskRepository } from "../task/task-repository.js";
import type { TaskStatus } from "../task/task.js";
import { BoardService, TaskNotFoundError } from "./board-service.js";

const run = <A, E>(effect: Effect.Effect<A, E, BoardService | TaskRepository | SourceItemRepository>) =>
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
        yield* taskWithItem("b", "todo");
        yield* taskWithItem("c", "in_progress");
        yield* taskWithItem("d", "done");
        yield* taskWithItem("e", "dismissed");
        yield* taskWithItem("f", "archived");

        const board = yield* (yield* BoardService).board;

        assert.deepStrictEqual(columnTitles(board), { needs_review: ["a"], todo: ["b"], in_progress: ["c"], done: ["d"] });
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
        assert.strictEqual(board.columns[1]?.cards[0]?.unreadChanges, 0);
      }),
    ));
});
