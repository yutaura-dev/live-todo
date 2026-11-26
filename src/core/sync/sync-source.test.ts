import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { TestDatabase } from "../db/test-database.js";
import { JudgeRequestError, type TodoJudgment, type TodoVerdict } from "../judge/todo-judge.js";
import { SourceItemRepository } from "../source/source-item-repository.js";
import { TaskRepository } from "../task/task-repository.js";
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

const batches = (...changes: SourceChange<Item>[][]) =>
  adapterReturning(...changes.map((batch, index) => ({ changes: batch, nextCursor: { page: index + 1 } })));

function judgeReturning(verdict: TodoVerdict) {
  return vi.fn((value: Item) =>
    Effect.succeed<TodoJudgment>({ verdict, method: "structured", request: { input: value.title, question: "q" } }),
  );
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
    toItemDraft: (value) => ({
      title: value.title,
      url: `https://example.com/${value.id}`,
      state: value.state === "closed" ? "resolved" : "open",
      fingerprint: `${value.title}:${value.version}`,
    }),
    judge,
  };
}

const syncTimes = (binding: SourceBinding<Item, Cursor, never, JudgeRequestError, never>, times: number) =>
  Effect.forEach(Array.from({ length: times }), () => syncSource(binding), { discard: true });

const taskOfItem = (externalId: string) =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const found = yield* items.findItem("test", externalId);
    if (Option.isNone(found)) return undefined;
    const task = yield* tasks.findTaskByItem(found.value.id);
    if (Option.isNone(task)) return undefined;
    return (yield* tasks.listTasks).find((candidate) => candidate.id === task.value.id);
  });

const activitiesOf = (externalId: string) =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const found = yield* items.findItem("test", externalId);
    if (Option.isNone(found)) return [];
    return (yield* items.listActivities(found.value.id)).map((activity) => activity.kind);
  });

describe("カーソル", () => {
  it.effect("初回は保存済みのカーソルなしで取得し、取得後のカーソルを保存する", () =>
    Effect.gen(function* () {
      const adapter = adapterReturning({ changes: [], nextCursor: { page: 2 } });

      yield* syncSource(bindingWith(adapter));

      expect(adapter.fetchChanges).toHaveBeenCalledWith(null);
      assert.deepStrictEqual(yield* (yield* SourceItemRepository).loadCursor("test"), Option.some({ page: 2 }));
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("2 回目以降は保存済みのカーソルで取得する", () =>
    Effect.gen(function* () {
      const adapter = batches([], []);

      yield* syncTimes(bindingWith(adapter), 2);

      expect(adapter.fetchChanges).toHaveBeenLastCalledWith({ page: 1 });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("保存されたカーソルが読めない形なら、カーソルなしで取得し直す", () =>
    Effect.gen(function* () {
      yield* (yield* SourceItemRepository).saveCursor("test", { unexpected: true });
      const adapter = batches([]);

      yield* syncSource(bindingWith(adapter));

      expect(adapter.fetchChanges).toHaveBeenCalledWith(null);
    }).pipe(Effect.provide(TestDatabase)));
});

describe("新しい Item", () => {
  it.effect.each([
    ["todo", "todo"],
    ["needs_review", "needs_review"],
    ["not_todo", "needs_review"],
  ] as const)("判定が %s なら、ステータス %s の Task を作って tracks で紐づける", ([verdict, status]) =>
    Effect.gen(function* () {
      yield* syncSource(bindingWith(batches([upserted(item())]), judgeReturning(verdict)));

      const task = yield* taskOfItem("a");
      assert.strictEqual(task?.status, status);
      assert.strictEqual(task?.title, "Task A");
      assert.deepStrictEqual(yield* (yield* TaskRepository).trackedItemStates(task!.id), ["open"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("判定が not_todo でも隠さず、要確認の Task にして判定を記録する（使いながら正解を集めるため）", () =>
    Effect.gen(function* () {
      yield* syncSource(bindingWith(batches([upserted(item())]), judgeReturning("not_todo")));

      const found = yield* (yield* SourceItemRepository).findItem("test", "a");
      assert.strictEqual((yield* taskOfItem("a"))?.status, "needs_review");
      assert.strictEqual(Option.getOrUndefined(found)?.triage, "linked");
      assert.deepInclude(Option.getOrUndefined(found)?.judgment, { verdict: "not_todo", method: "structured" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("初めて見た時点で解決済みなら、Task を作らず判定もしない", () =>
    Effect.gen(function* () {
      const judge = judgeReturning("todo");

      yield* syncSource(bindingWith(batches([upserted(item({ state: "closed" }))]), judge));

      assert.isUndefined(yield* taskOfItem("a"));
      expect(judge).not.toHaveBeenCalled();
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("解決済みで見送った Item が再オープンされたら、そのとき判定して Task を作る", () =>
    Effect.gen(function* () {
      const binding = bindingWith(batches([upserted(item({ state: "closed" }))], [upserted(item({ state: "open" }))]));

      yield* syncTimes(binding, 2);

      assert.strictEqual((yield* taskOfItem("a"))?.status, "todo");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("Task を作った Item にも、判定の結果を記録する", () =>
    Effect.gen(function* () {
      yield* syncSource(bindingWith(batches([upserted(item())]), judgeReturning("needs_review")));

      const found = yield* (yield* SourceItemRepository).findItem("test", "a");
      assert.deepInclude(Option.getOrUndefined(found)?.judgment, { verdict: "needs_review", method: "structured" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("新しく作った Task には更新マークを付けない", () =>
    Effect.gen(function* () {
      yield* syncSource(bindingWith(batches([upserted(item())])));

      assert.strictEqual((yield* taskOfItem("a"))?.unreadChanges, 0);
    }).pipe(Effect.provide(TestDatabase)));
});

describe("Item の変化と Task の更新", () => {
  it.effect("Item の内容の変化は Activity として記録するが、Task の更新マークにはしない", () =>
    Effect.gen(function* () {
      const binding = bindingWith(batches([upserted(item())], [upserted(item({ title: "Task A (renamed)", version: 2 }))]));

      yield* syncTimes(binding, 2);

      const task = yield* taskOfItem("a");
      assert.deepStrictEqual(yield* activitiesOf("a"), ["appeared", "changed"]);
      assert.strictEqual(task?.unreadChanges, 0);
      assert.strictEqual(task?.title, "Task A");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("tracks の Item が解決したら Task を done にし、status の変更として更新マークを付ける", () =>
    Effect.gen(function* () {
      const binding = bindingWith(batches([upserted(item())], [upserted(item({ state: "closed", version: 2 }))]));

      yield* syncTimes(binding, 2);

      const task = yield* taskOfItem("a");
      const changes = yield* (yield* TaskRepository).listChanges(task!.id);
      assert.strictEqual(task?.status, "done");
      assert.strictEqual(task?.unreadChanges, 1);
      assert.deepInclude(changes.at(-1), { kind: "field_changed", field: "status", before: "todo", after: "done" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("done の Task は、tracks の Item が再オープンされたら todo に戻す", () =>
    Effect.gen(function* () {
      const binding = bindingWith(
        batches(
          [upserted(item())],
          [upserted(item({ state: "closed", version: 2 }))],
          [upserted(item({ state: "open", version: 3 }))],
        ),
      );

      yield* syncTimes(binding, 3);

      assert.strictEqual((yield* taskOfItem("a"))?.status, "todo");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("tracks の Item が消えたら Task を archived にし、更新マークを付ける", () =>
    Effect.gen(function* () {
      const binding = bindingWith(batches([upserted(item())], [{ kind: "removed", externalId: "a" }]));

      yield* syncTimes(binding, 2);

      const task = yield* taskOfItem("a");
      assert.strictEqual(task?.status, "archived");
      assert.strictEqual(task?.unreadChanges, 1);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("ユーザーが in_progress にした Task は、Item が開いたまま変化しても in_progress のまま", () =>
    Effect.gen(function* () {
      const binding = bindingWith(batches([upserted(item())], [upserted(item({ version: 2 }))]));
      yield* syncSource(binding);
      const task = yield* taskOfItem("a");
      yield* (yield* TaskRepository).updateTask(task!.id, { status: "in_progress" });

      yield* syncSource(binding);

      assert.strictEqual((yield* taskOfItem("a"))?.status, "in_progress");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("一度判定した Item は、内容が変わっても判定し直さない", () =>
    Effect.gen(function* () {
      const judge = judgeReturning("todo");
      const binding = bindingWith(batches([upserted(item())], [upserted(item({ version: 2 }))]), judge);

      yield* syncTimes(binding, 2);

      expect(judge).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("not_todo と判定した Item は、内容が変わっても判定し直さない", () =>
    Effect.gen(function* () {
      const judge = judgeReturning("not_todo");
      const binding = bindingWith(batches([upserted(item())], [upserted(item({ version: 2 }))]), judge);

      yield* syncTimes(binding, 2);

      expect(judge).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(TestDatabase)));
});

const followingTitles = (binding: SourceBinding<Item, Cursor, never, JudgeRequestError, never>) => ({ ...binding, taskTitleFollowsItem: true });

describe("元の項目のタイトルに Task のタイトルを合わせる Source（Slack など、タイトルを機械的に作る Source）", () => {
  it.effect("Task のタイトルを書き換えていなければ、新しいタイトルに合わせる（更新マークは付けない）", () =>
    Effect.gen(function* () {
      yield* syncTimes(followingTitles(bindingWith(batches([upserted(item({ title: "<@U1>" }))], [upserted(item({ title: "#general: 請求書を直す", version: 2 }))]))), 2);

      const task = yield* taskOfItem("a");
      assert.strictEqual(task?.title, "#general: 請求書を直す");
      assert.strictEqual(task?.unreadChanges, 0);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("自分で書き換えた Task のタイトルは、そのままにする", () =>
    Effect.gen(function* () {
      const binding = followingTitles(bindingWith(batches([upserted(item({ title: "元のタイトル" }))], [upserted(item({ title: "新しいタイトル", version: 2 }))])));
      yield* syncSource(binding);
      const created = (yield* taskOfItem("a"))!;
      yield* (yield* TaskRepository).updateTask(created.id, { title: "自分で書いたタイトル" });

      yield* syncSource(binding);

      assert.strictEqual((yield* taskOfItem("a"))?.title, "自分で書いたタイトル");
    }).pipe(Effect.provide(TestDatabase)));
});

describe("仕分けを保留にする Source（Slack のメンション・DM など、会話ごとにあとで考える Source）", () => {
  it.effect("新しい項目を判定せず、Task も作らずに、仕分けを保留のまま取り込む", () =>
    Effect.gen(function* () {
      const judge = judgeReturning("todo");
      const binding = { ...bindingWith(batches([upserted(item())]), judge), deferTriage: true };

      const summary = yield* syncSource(binding);

      assert.strictEqual(summary.tasksCreated, 0);
      expect(judge).not.toHaveBeenCalled();
      const stored = yield* (yield* SourceItemRepository).findItem("test", "a");
      assert.strictEqual(Option.getOrThrow(stored).triage, "pending");
    }).pipe(Effect.provide(TestDatabase)));
});

describe("失敗時", () => {
  it.effect("判定に失敗したら、途中までの変更もカーソルも保存しない", () =>
    Effect.gen(function* () {
      const judge = vi.fn((value: Item) =>
        value.id === "b"
          ? Effect.fail(new JudgeRequestError({ message: "network" }))
          : Effect.succeed<TodoJudgment>({ verdict: "todo", method: "structured", request: { input: value.title, question: "q" } }),
      );

      const error = yield* Effect.flip(
        syncSource(bindingWith(batches([upserted(item({ id: "a" })), upserted(item({ id: "b" }))]), judge)),
      );

      const items = yield* SourceItemRepository;
      assert.instanceOf(error, JudgeRequestError);
      assert.isTrue(Option.isNone(yield* items.findItem("test", "a")));
      assert.deepStrictEqual(yield* (yield* TaskRepository).listTasks, []);
      assert.isTrue(Option.isNone(yield* items.loadCursor("test")));
    }).pipe(Effect.provide(TestDatabase)));
});
