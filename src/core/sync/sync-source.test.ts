import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { JudgeRequestError, type TodoJudgment, type TodoVerdict } from "../judge/todo-judge.js";
import { TaskRepository } from "../task/task-repository.js";
import { TaskRepositoryTest } from "../task/test-database.js";
import type { FetchChangesResult, SourceAdapter } from "./source-adapter.js";
import type { SourceChange } from "./source-change.js";
import { type SourceBinding, syncSource } from "./sync-source.js";

type Item = { id: string; title: string; state: "open" | "closed"; version: number };
type Cursor = { page: number };

const item = (overrides: Partial<Item> = {}): Item => ({ id: "a", title: "Task A", state: "open", version: 1, ...overrides });
const upserted = (value: Item): SourceChange<Item> => ({ kind: "upserted", item: value });

function adapterReturning(...results: FetchChangesResult<Item, Cursor>[]) {
  const fetchChanges = vi.fn<SourceAdapter<Item, Cursor, never>["fetchChanges"]>();
  for (const result of results) fetchChanges.mockReturnValueOnce(Effect.succeed(result));
  return { fetchChanges };
}

function judgeReturning(verdict: TodoVerdict) {
  return vi.fn((_: Item) => Effect.succeed<TodoJudgment>({ verdict, method: "structured" }));
}

function bindingWith(
  adapter: SourceAdapter<Item, Cursor, never>,
  judge: (value: Item) => Effect.Effect<TodoJudgment, JudgeRequestError> = judgeReturning("todo"),
): SourceBinding<Item, Cursor, never, JudgeRequestError, never> {
  return {
    source: "test",
    adapter,
    cursorSchema: Schema.Struct({ page: Schema.Number }),
    externalIdOf: (value) => value.id,
    toDraft: (value) => ({
      title: value.title,
      url: `https://example.com/${value.id}`,
      fingerprint: `${value.title}:${value.version}`,
      resolved: value.state === "closed",
    }),
    judge,
  };
}

const run = <A, E>(effect: Effect.Effect<A, E, TaskRepository>) => effect.pipe(Effect.provide(TaskRepositoryTest));

const taskOf = (externalId: string) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepository;
    return (yield* repo.listTasks).find((task) => task.externalId === externalId);
  });

describe("カーソル", () => {
  it.effect("初回は保存済みのカーソルなしで取得し、取得後のカーソルを保存する", () =>
    run(
      Effect.gen(function* () {
        const adapter = adapterReturning({ changes: [], nextCursor: { page: 2 } });

        yield* syncSource(bindingWith(adapter));

        const repo = yield* TaskRepository;
        expect(adapter.fetchChanges).toHaveBeenCalledWith(null);
        assert.deepStrictEqual(yield* repo.loadCursor("test"), Option.some({ page: 2 }));
      }),
    ));

  it.effect("2 回目以降は保存済みのカーソルで取得する", () =>
    run(
      Effect.gen(function* () {
        const adapter = adapterReturning(
          { changes: [], nextCursor: { page: 2 } },
          { changes: [], nextCursor: { page: 3 } },
        );
        const binding = bindingWith(adapter);

        yield* syncSource(binding);
        yield* syncSource(binding);

        expect(adapter.fetchChanges).toHaveBeenLastCalledWith({ page: 2 });
      }),
    ));

  it.effect("保存されたカーソルが読めない形なら、カーソルなしで取得し直す", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TaskRepository;
        yield* repo.saveCursor("test", { unexpected: true });
        const adapter = adapterReturning({ changes: [], nextCursor: { page: 1 } });

        yield* syncSource(bindingWith(adapter));

        expect(adapter.fetchChanges).toHaveBeenCalledWith(null);
      }),
    ));
});

describe("新しい項目", () => {
  it.effect.each([
    ["todo", "todo"],
    ["needs_review", "needs_review"],
    ["not_todo", "dismissed"],
  ] as const)("判定が %s なら、ステータス %s の Task を作る", ([verdict, status]) =>
    run(
      Effect.gen(function* () {
        const adapter = adapterReturning({ changes: [upserted(item())], nextCursor: { page: 1 } });

        yield* syncSource(bindingWith(adapter, judgeReturning(verdict)));

        const task = yield* taskOf("a");
        assert.strictEqual(task?.status, status);
        assert.strictEqual(task?.title, "Task A");
      }),
    ));

  it.effect("すでに解決済みなら Task を作らず、判定もしない", () =>
    run(
      Effect.gen(function* () {
        const judge = judgeReturning("todo");
        const adapter = adapterReturning({ changes: [upserted(item({ state: "closed" }))], nextCursor: { page: 1 } });

        yield* syncSource(bindingWith(adapter, judge));

        assert.isUndefined(yield* taskOf("a"));
        expect(judge).not.toHaveBeenCalled();
      }),
    ));

  it.effect("新しく作った Task には更新マークを付けない", () =>
    run(
      Effect.gen(function* () {
        const adapter = adapterReturning({ changes: [upserted(item())], nextCursor: { page: 1 } });

        yield* syncSource(bindingWith(adapter));

        assert.strictEqual((yield* taskOf("a"))?.unreadChanges, 0);
      }),
    ));
});

describe("既存の Task の更新", () => {
  const syncTwice = (second: Item, firstVerdict: TodoVerdict = "todo") =>
    Effect.gen(function* () {
      const judge = judgeReturning(firstVerdict);
      const adapter = adapterReturning(
        { changes: [upserted(item())], nextCursor: { page: 1 } },
        { changes: [upserted(second)], nextCursor: { page: 2 } },
      );
      const binding = bindingWith(adapter, judge);
      yield* syncSource(binding);
      yield* syncSource(binding);
      return { judge, task: yield* taskOf("a") };
    });

  it.effect("内容が変わった Task を更新し、更新マークを付ける", () =>
    run(
      Effect.gen(function* () {
        const { task } = yield* syncTwice(item({ title: "Task A (renamed)", version: 2 }));

        assert.strictEqual(task?.title, "Task A (renamed)");
        assert.strictEqual(task?.unreadChanges, 1);
      }),
    ));

  it.effect("内容が変わっていなければ更新マークを付けない", () =>
    run(
      Effect.gen(function* () {
        const { task } = yield* syncTwice(item());

        assert.strictEqual(task?.unreadChanges, 0);
      }),
    ));

  it.effect("既存の Task は内容が変わっても判定し直さない", () =>
    run(
      Effect.gen(function* () {
        const { judge } = yield* syncTwice(item({ version: 2 }));

        expect(judge).toHaveBeenCalledTimes(1);
      }),
    ));

  it.effect("解決済みになった Task を done にし、更新マークを付ける", () =>
    run(
      Effect.gen(function* () {
        const { task } = yield* syncTwice(item({ state: "closed", version: 2 }));

        assert.strictEqual(task?.status, "done");
        assert.isAbove(task?.unreadChanges ?? 0, 0);
      }),
    ));

  it.effect("done の Task が再オープンされたら todo に戻す", () =>
    run(
      Effect.gen(function* () {
        const adapter = adapterReturning(
          { changes: [upserted(item())], nextCursor: { page: 1 } },
          { changes: [upserted(item({ state: "closed", version: 2 }))], nextCursor: { page: 2 } },
          { changes: [upserted(item({ state: "open", version: 3 }))], nextCursor: { page: 3 } },
        );
        const binding = bindingWith(adapter);

        yield* syncSource(binding);
        yield* syncSource(binding);
        yield* syncSource(binding);

        assert.strictEqual((yield* taskOf("a"))?.status, "todo");
      }),
    ));

  it.effect("対象外の Task は解決・更新されても dismissed のままにし、更新マークも付けない", () =>
    run(
      Effect.gen(function* () {
        const { task } = yield* syncTwice(item({ state: "closed", version: 2 }), "not_todo");

        assert.strictEqual(task?.status, "dismissed");
        assert.strictEqual(task?.unreadChanges, 0);
      }),
    ));

  it.effect("削除された項目の Task を archived にし、更新マークを付ける", () =>
    run(
      Effect.gen(function* () {
        const adapter = adapterReturning(
          { changes: [upserted(item())], nextCursor: { page: 1 } },
          { changes: [{ kind: "removed", externalId: "a" }], nextCursor: { page: 2 } },
        );
        const binding = bindingWith(adapter);

        yield* syncSource(binding);
        yield* syncSource(binding);

        const task = yield* taskOf("a");
        assert.strictEqual(task?.status, "archived");
        assert.strictEqual(task?.unreadChanges, 1);
      }),
    ));
});

describe("失敗時", () => {
  it.effect("判定に失敗したら、途中までの変更もカーソルも保存しない", () =>
    run(
      Effect.gen(function* () {
        const judge = vi.fn((value: Item) =>
          value.id === "b"
            ? Effect.fail(new JudgeRequestError({ message: "network" }))
            : Effect.succeed<TodoJudgment>({ verdict: "todo", method: "structured" }),
        );
        const adapter = adapterReturning({
          changes: [upserted(item({ id: "a" })), upserted(item({ id: "b" }))],
          nextCursor: { page: 1 },
        });

        const error = yield* Effect.flip(syncSource(bindingWith(adapter, judge)));

        const repo = yield* TaskRepository;
        assert.instanceOf(error, JudgeRequestError);
        assert.deepStrictEqual(yield* repo.listTasks, []);
        assert.isTrue(Option.isNone(yield* repo.loadCursor("test")));
      }),
    ));
});
