import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { DateTime, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as Spec from "../../../specs/task.spec.ts";
import { StoreDatabase } from "../../store/database.js";
import { TaskStore } from "../../store/task-store.js";
import { sequentialIds, TaskService } from "./task-service.js";

const layer = TaskService.layer.pipe(
  Layer.provideMerge(TaskStore.layer),
  Layer.provide(StoreDatabase.layer({ filename: ":memory:" })),
  Layer.provide(sequentialIds("t")),
);

const at = (iso: string) => TestClock.setTime(DateTime.makeUnsafe(iso).epochMilliseconds);

describe("TaskService（画面からの操作を、ユーザーの操作として Task に当てて保存する）", () => {
  it.effect("手で Task を足すと、ボードのやることに新着で出る", () =>
    Effect.gen(function* () {
      yield* at("2026-11-28T09:00:00Z");
      const service = yield* TaskService;
      const created = yield* service.command({ _tag: "CreateTask", title: "請求書を送る", brief: null });
      assert.deepStrictEqual(created.ok ? { id: created.value.id, status: created.value.status, mark: created.value.mark } : created, { id: "t1", status: "やること", mark: "新着" });
      assert.deepStrictEqual(yield* service.board(), { ok: true, value: [{ id: "t1", title: "請求書を送る", status: "やること", mark: "新着", due: null }] });
    }).pipe(Effect.provide(layer)));

  it.effect("開くと新着が消え、完了にすると終わった列に移る", () =>
    Effect.gen(function* () {
      const service = yield* TaskService;
      yield* service.command({ _tag: "CreateTask", title: "請求書を送る", brief: null });
      yield* service.command({ _tag: "ViewTask", id: "t1" });
      yield* service.command({ _tag: "CompleteTask", id: "t1" });
      assert.deepStrictEqual(yield* service.board(), { ok: true, value: [{ id: "t1", title: "請求書を送る", status: "終わった", mark: "なし", due: null }] });
    }).pipe(Effect.provide(layer)));

  it.effect("やらないことにした Task は、ボードから消える", () =>
    Effect.gen(function* () {
      const service = yield* TaskService;
      yield* service.command({ _tag: "CreateTask", title: "請求書を送る", brief: null });
      yield* service.command({ _tag: "DismissTask", id: "t1" });
      assert.deepStrictEqual(yield* service.board(), { ok: true, value: [] });
    }).pipe(Effect.provide(layer)));

  it.effect(specOf(Spec.complete, "やること のときだけ") + "（画面には spec の理由の文で断る）", () =>
    Effect.gen(function* () {
      const service = yield* TaskService;
      yield* service.command({ _tag: "CreateTask", title: "請求書を送る", brief: null });
      yield* service.command({ _tag: "CompleteTask", id: "t1" });
      assert.deepStrictEqual(yield* service.command({ _tag: "CompleteTask", id: "t1" }), { ok: false, reason: "やること のときだけ" });
    }).pipe(Effect.provide(layer)));

  it.effect("ない Task への操作は、見つからないとして断る", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* (yield* TaskService).command({ _tag: "CompleteTask", id: "nope" }), { ok: false, reason: "Task が見つかりません" });
    }).pipe(Effect.provide(layer)));

  it.effect("Task が変わるたびに、変わったことを知らせる（画面が読み直せるように）", () =>
    Effect.gen(function* () {
      const service = yield* TaskService;
      const seen: string[] = [];
      yield* service.onChanged((id) => seen.push(id));
      yield* service.command({ _tag: "CreateTask", title: "請求書を送る", brief: null });
      yield* service.command({ _tag: "CompleteTask", id: "t1" });
      assert.deepStrictEqual(seen, ["t1", "t1"]);
    }).pipe(Effect.provide(layer)));
});
