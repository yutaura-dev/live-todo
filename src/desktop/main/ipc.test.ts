import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { StoreDatabase } from "../../store/database.js";
import { TaskStore } from "../../store/task-store.js";
import { handleCommand, handleQuery } from "./ipc.js";
import { sequentialIds, TaskService } from "./task-service.js";

const layer = TaskService.layer.pipe(Layer.provide(TaskStore.layer), Layer.provide(StoreDatabase.layer({ filename: ":memory:" })), Layer.provide(sequentialIds("t")));

describe("IPC（renderer から届いたものを、形を確かめてから TaskService に渡す）", () => {
  it.effect("形の正しい操作は、そのまま当てる", () =>
    Effect.gen(function* () {
      const reply = yield* handleCommand({ _tag: "CreateTask", title: "請求書を送る", brief: null });
      assert.isTrue(reply.ok);
    }).pipe(Effect.provide(layer)));

  it.effect("形の正しくない操作は、当てずに断る（renderer からは何が届くか分からないため）", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* handleCommand({ _tag: "DeleteEverything" }), { ok: false, reason: "操作の形が正しくありません" });
      assert.deepStrictEqual(yield* handleCommand({ _tag: "CompleteTask", id: "" }), { ok: false, reason: "操作の形が正しくありません" });
    }).pipe(Effect.provide(layer)));

  it.effect("ボードと Task の読み出しも、形を確かめる", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* handleQuery({ _tag: "Board" }), { ok: true, value: [] });
      assert.deepStrictEqual(yield* handleQuery({ _tag: "Task" }), { ok: false, reason: "読み出しの形が正しくありません" });
    }).pipe(Effect.provide(layer)));
});
