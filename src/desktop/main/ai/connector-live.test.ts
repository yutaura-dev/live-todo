import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { liveConnector } from "./connector-live.js";
import { AiConnector } from "./connector.js";

const connect = (...args: Parameters<AiConnector["Service"]["connect"]>) =>
  Effect.gen(function* () {
    return yield* (yield* AiConnector).connect(...args);
  });

const commandsOk = () => Effect.succeed(true);
const commandsMissing = () => Effect.succeed(false);

describe("AI につなぐ口（実 API は呼ばない範囲）", () => {
  it.effect("API キーが .env.local になければ、どの名前で書けばよいかを返す", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* connect("decisions", { provider: "openai-decisions", model: "gpt-6-luna" }, { verify: true }), {
        ok: false,
        message: "LIVE_TODO_SECRET_LLM_OPENAI_API_KEY を .env.local に書いてください",
      });
    }).pipe(Effect.provide(liveConnector({ env: {}, commandSucceeds: commandsOk }))));

  it.effect("一覧にない AI にはつながない", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* connect("decisions", { provider: "somewhere", model: null }, { verify: false }), { ok: false, message: "選べない AI です" });
    }).pipe(Effect.provide(liveConnector({ env: {}, commandSucceeds: commandsOk }))));

  it.effect("確かめずにつなぐだけなら、API を呼ばずに Decisions を用意する（起動したとき）", () =>
    Effect.gen(function* () {
      const result = yield* connect("decisions", { provider: "openai-decisions", model: "gpt-6-luna" }, { verify: false });
      assert.isTrue(result.ok && result.connected.decisions !== undefined);
    }).pipe(Effect.provide(liveConnector({ env: { LIVE_TODO_SECRET_LLM_OPENAI_API_KEY: "test-key" }, commandSucceeds: commandsOk }))));

  it.effect("Claude Code は、claude コマンドが動けば通る", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* connect("agent", { provider: "claude-code", model: null }, { verify: true }), { ok: true, connected: {} });
    }).pipe(Effect.provide(liveConnector({ env: {}, commandSucceeds: commandsOk }))));

  it.effect("claude コマンドがなければ、入れるよう伝える", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* connect("agent", { provider: "claude-code", model: null }, { verify: true }), {
        ok: false,
        message: "claude コマンドが見つかりません。Claude Code を入れて、ログインしてください",
      });
    }).pipe(Effect.provide(liveConnector({ env: {}, commandSucceeds: commandsMissing }))));
});
