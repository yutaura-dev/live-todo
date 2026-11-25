import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Layer, Schema } from "effect";
import { SecretStore } from "../core/config/secret-store.js";
import { ConservativeClassifier } from "../core/judge/conservative-classifier.js";
import { LlmStructuredClassifier } from "../core/judge/llm-classifier.js";
import { StructuredClassifier } from "../core/judge/todo-judge.js";
import type { LlmProfile } from "./config/app-config.js";

export class UnsupportedLlmProviderError extends Schema.TaggedError<UnsupportedLlmProviderError>()(
  "UnsupportedLlmProviderError",
  { provider: Schema.String },
) {}

const buildClassifier = <E, R>(layer: Layer.Layer<StructuredClassifier, E, R>) =>
  Effect.gen(function* () {
    return yield* StructuredClassifier;
  }).pipe(Effect.provide(layer));

/** LLM Profile から StructuredClassifier を作る。アカウントごとに呼び、そのアカウントのジョブにだけ渡す */
export const makeStructuredClassifier = Effect.fnUntraced(function* (profile: LlmProfile) {
  const secrets = yield* SecretStore;
  switch (profile.provider) {
    case "none":
      return yield* buildClassifier(ConservativeClassifier);
    case "anthropic": {
      const apiKey = yield* secrets.require("llm.anthropic.api_key");
      return yield* buildClassifier(
        LlmStructuredClassifier.pipe(
          Layer.provide(AnthropicLanguageModel.model(profile.model)),
          Layer.provide(AnthropicClient.layer({ apiKey })),
        ),
      );
    }
    case "openai": {
      const apiKey = yield* secrets.require("llm.openai.api_key");
      return yield* buildClassifier(
        LlmStructuredClassifier.pipe(
          Layer.provide(OpenAiLanguageModel.model(profile.model)),
          Layer.provide(OpenAiClient.layer({ apiKey })),
        ),
      );
    }
    default:
      // Gemini（@effect/ai-google が v4 に未対応）・Azure OpenAI・Bedrock は、使うときに足す
      return yield* new UnsupportedLlmProviderError({ provider: profile.provider });
  }
});
