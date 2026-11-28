import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { StoreDatabase } from "../../store/database.js";
import { handleAiCommand, handleCommand, handleInbox, handleQuery } from "./ipc.js";
import { AiConnector } from "./ai/connector.js";
import { SourceGateway } from "./sources/gateway.js";
import { WriteProvider } from "./writes/write-provider.js";
import { agentTest } from "../../llm/agent/test-double.js";
import { unanswered } from "../../llm/shared/answer.js";
import { desktopLayer } from "./layer.js";
import { Calendar } from "./prioritizer.js";
import { sequentialIds } from "./task-service.js";

const layer = desktopLayer({ database: StoreDatabase.layer({ filename: ":memory:" }), calendar: Calendar.fixed({ today: "2026-11-28", timeZone: "Asia/Tokyo" }), ids: sequentialIds("t"), connector: AiConnector.unavailable, gateway: SourceGateway.live({}), writer: (stores) => WriteProvider.live({}).pipe(Layer.provide(stores)), agent: agentTest({ run: () => [], askToStop: () => unanswered("Missing") }).layer });

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

  it.effect("書き込みを頼む操作は、書き込みの口に渡す（ない Task なら断る）", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* handleInbox({ _tag: "RequestWrite", taskId: "nope", itemId: "a1" }), { ok: false, reason: "Task が見つかりません" });
      assert.deepStrictEqual(yield* handleInbox({ _tag: "ApproveWrite", id: "nope" }), { ok: false, reason: "書き込みが見つかりません" });
    }).pipe(Effect.provide(layer)));

  it.effect("Claude Code に頼む操作は、Agent の口に渡す（ない Task・作業なら断る。空の頼みは形で断る）", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* handleInbox({ _tag: "AskAgent", taskId: "nope", request: "なぜ？" }), { ok: false, reason: "Task が見つかりません" });
      assert.deepStrictEqual(yield* handleInbox({ _tag: "AskAgent", taskId: "t1", request: "" }), { ok: false, reason: "操作の形が正しくありません" });
      assert.deepStrictEqual(yield* handleInbox({ _tag: "RequestAgent", taskId: "nope", itemId: "a1" }), { ok: false, reason: "Task が見つかりません" });
      assert.deepStrictEqual(yield* handleInbox({ _tag: "StopAgent", id: "nope" }), { ok: false, reason: "作業が見つかりません" });
      assert.deepStrictEqual(yield* handleInbox({ _tag: "CancelAgent", id: "nope" }), { ok: false, reason: "作業が見つかりません" });
    }).pipe(Effect.provide(layer)));
});
