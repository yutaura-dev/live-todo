import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { EnvSecretStore } from "../core/config/secret-store.js";
import type { LlmProfile } from "./config/app-config.js";
import { checkLlmProfile } from "./llm-check.js";

const AZURE: LlmProfile = {
  provider: "azure-openai",
  model: "my-gpt",
  azure: { endpoint: "https://acme.openai.azure.com" },
  decisions: { provider: "azure-openai" },
};

const run = (env: Record<string, string>, http: HttpClient.HttpClient) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(EnvSecretStore),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    );

const failing = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 401 }))));

describe("checkLlmProfile", () => {
  it.effect("LLM を使わないなら、判定だけを確かめて API は呼ばない", () =>
    Effect.gen(function* () {
      const results = yield* checkLlmProfile({ provider: "none", model: "-" });

      assert.deepStrictEqual(results.map(({ name, ok }) => ({ name, ok })), [{ name: "判定（structured output）", ok: true }]);
    }).pipe(run({}, failing)));

  it.effect("decisions があれば、todo の確率とメールの仕分けも確かめる", () =>
    Effect.gen(function* () {
      const results = yield* checkLlmProfile(AZURE);

      assert.deepStrictEqual(results.map(({ name }) => name), ["判定（structured output）", "todo の確率（Decisions）", "メールの仕分け（Decisions）"]);
    }).pipe(run({ LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY: "az-test" }, failing)));

  it.effect("呼び出しに失敗しても止めずに、すべての項目を失敗として返す", () =>
    Effect.gen(function* () {
      const results = yield* checkLlmProfile(AZURE);

      assert.isTrue(results.every((result) => !result.ok));
    }).pipe(run({ LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY: "az-test" }, failing)));

  it.effect("API キーがなければ、どの環境変数に書けばよいかを示す", () =>
    Effect.gen(function* () {
      const results = yield* checkLlmProfile(AZURE);

      assert.include(results[0]?.detail, "LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY");
    }).pipe(run({}, failing)));

  it.effect("結果に API キーを含めない", () =>
    Effect.gen(function* () {
      const results = yield* checkLlmProfile(AZURE);

      assert.notInclude(JSON.stringify(results), "az-secret-value");
    }).pipe(run({ LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY: "az-secret-value" }, failing)));
});
