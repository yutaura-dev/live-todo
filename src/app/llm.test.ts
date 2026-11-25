import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { EnvSecretStore, MissingSecretError } from "../core/config/secret-store.js";
import { makeStructuredClassifier, UnsupportedLlmProviderError } from "./llm.js";

const withEnv = (env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(Layer.mergeAll(EnvSecretStore, FetchHttpClient.layer)),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    );

describe("makeStructuredClassifier", () => {
  it.effect("provider が none なら LLM を使わず、規則で決まらないものをすべて要確認に回す", () =>
    Effect.gen(function* () {
      const classifier = yield* makeStructuredClassifier({ provider: "none", model: "-" });

      assert.strictEqual(yield* classifier.classifyTodo({ input: "x", question: "q" }), "uncertain");
    }).pipe(withEnv({})));

  it.effect("API キーがなければ、どのキーがないかを示すエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeStructuredClassifier({ provider: "anthropic", model: "claude-haiku-5-5" }));

      assert.instanceOf(error, MissingSecretError);
      assert.strictEqual(error.key, "llm.anthropic.api_key");
    }).pipe(withEnv({})));

  it.effect("API キーがあれば classifier を作れる（作るだけでは LLM を呼ばない）", () =>
    Effect.gen(function* () {
      const classifier = yield* makeStructuredClassifier({ provider: "anthropic", model: "claude-haiku-5-5" });

      assert.isFunction(classifier.classifyTodo);
    }).pipe(withEnv({ LIVE_TODO_SECRET_LLM_ANTHROPIC_API_KEY: "sk-test" })));

  it.effect("まだ対応していない provider は、起動時にエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeStructuredClassifier({ provider: "gemini", model: "gemini-x" }));

      assert.instanceOf(error, UnsupportedLlmProviderError);
      assert.strictEqual(error.provider, "gemini");
    }).pipe(withEnv({})));
});

