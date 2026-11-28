import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { StoreDatabase } from "../../store/database.js";
import { handleAiCommand, handleCommand, handleQuery } from "./ipc.js";
import { AiConnector } from "./ai/connector.js";
import { desktopLayer } from "./layer.js";
import { Calendar } from "./prioritizer.js";
import { sequentialIds } from "./task-service.js";

const layer = desktopLayer({ database: StoreDatabase.layer({ filename: ":memory:" }), calendar: Calendar.fixed({ today: "2026-11-28", timeZone: "Asia/Tokyo" }), ids: sequentialIds("t"), connector: AiConnector.unavailable });

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

  it.effect("AI 設定の操作も、形を確かめる", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* handleAiCommand({ _tag: "ConfigureAi", use: "everything", option: "x" }), { ok: false, reason: "操作の形が正しくありません" });
      assert.deepStrictEqual(yield* handleAiCommand({ _tag: "ConfigureAi", use: "decisions", option: "openai-decisions" }), { ok: false, reason: "テストでは AI につながない" });
    }).pipe(Effect.provide(layer)));
});
