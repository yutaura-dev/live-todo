import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { create } from "../domain/task/task.js";
import { StoreDatabase } from "./database.js";
import { PrioritizationStore } from "./prioritization-store.js";
import { TaskStore } from "./task-store.js";

const layer = Layer.mergeAll(PrioritizationStore.layer, TaskStore.layer).pipe(Layer.provideMerge(StoreDatabase.layer({ filename: ":memory:" })));

describe("PrioritizationStore（Task ごとの優先度の決まり方を保存する）", () => {
  it.effect("保存した決まり方を Task の ID で読み出し、保存し直すと置き換える", () =>
    Effect.gen(function* () {
      yield* (yield* TaskStore).save(yield* create({ id: "t1", title: "請求書を送る", actor: { kind: "user" }, origin: "手で足した" }));
      const store = yield* PrioritizationStore;
      yield* store.save({ status: "未判定", taskId: "t1", priority: null, basisFingerprint: "b1", drivenByItemId: null });
      const decided = { status: "アプリが決めた", taskId: "t1", priority: { level: "今日中", reason: "期日まで余裕がない" }, basisFingerprint: "b1", drivenByItemId: null } as const;
      yield* store.save(decided);
      assert.deepStrictEqual(yield* store.find("t1"), Option.some(decided));
      assert.deepStrictEqual(yield* store.all(), [decided]);
    }).pipe(Effect.provide(layer)));

  it.effect("まだ決め始めていない Task は none", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* (yield* PrioritizationStore).find("t1")));
    }).pipe(Effect.provide(layer)));
});
