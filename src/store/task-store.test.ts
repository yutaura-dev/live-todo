import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { complete, create, dismiss, setDue, type Task } from "../domain/task/task.js";
import { StoreDatabase } from "./database.js";
import { TaskStore } from "./task-store.js";

const layer = TaskStore.layer.pipe(Layer.provideMerge(StoreDatabase.layer({ filename: ":memory:" })));
const user = { kind: "user" } as const;
const none = { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" } as const;

const newTask = (id: string, title: string) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T09:00:00Z").epochMilliseconds);
    return yield* create({ id, title, actor: user, origin: "手で足した" });
  });

describe("TaskStore（Task と、その出来事を保存する）", () => {
  it.effect("保存した Task を、出来事も含めてそのまま読み出せる", () =>
    Effect.gen(function* () {
      const store = yield* TaskStore;
      const task = yield* setDue(yield* newTask("t1", "請求書を送る"), user, {
        text: "金曜まで",
        earliest: "2026-12-04T00:00:00.000Z",
        latest: "2026-12-04T23:59:59.000Z",
        precision: "日",
      });
      yield* store.save(task);
      assert.deepStrictEqual(yield* store.find("t1"), Option.some(task));
    }).pipe(Effect.provide(layer)));

  it.effect("保存し直すと、前の出来事は残したまま、新しい出来事だけを足す", () =>
    Effect.gen(function* () {
      const store = yield* TaskStore;
      const task = yield* newTask("t1", "請求書を送る");
      yield* store.save(task);
      const done = yield* complete(task, user, "自分で完了にした", none);
      yield* store.save(done);
      const found = Option.getOrThrow(yield* store.find("t1"));
      assert.deepStrictEqual(found.history, done.history);
      assert.strictEqual(found.status, "終わった");
    }).pipe(Effect.provide(layer)));

  it.effect("ない Task は none", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* (yield* TaskStore).find("nope")));
    }).pipe(Effect.provide(layer)));

  it.effect("ボードには、やらないことにした Task を出さない（やること・完了待ち・やり終えたものだけ）", () =>
    Effect.gen(function* () {
      const store = yield* TaskStore;
      const open: Task = yield* newTask("t1", "開いている");
      const done = yield* complete(yield* newTask("t2", "やり終えた"), user, "自分で完了にした", none);
      const gone = yield* dismiss(yield* newTask("t3", "片付けた"), user, "自分で片付けた", "頼んだものはない");
      yield* Effect.forEach([open, done, gone], store.save);
      assert.deepStrictEqual((yield* store.listForBoard()).map((task) => task.id).sort(), ["t1", "t2"]);
    }).pipe(Effect.provide(layer)));
});
