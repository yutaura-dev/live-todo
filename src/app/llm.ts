import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiDecisionModel, OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Layer, Option, Schema } from "effect";
import { SecretStore } from "../core/config/secret-store.js";
import { ConservativeClassifier } from "../core/judge/conservative-classifier.js";
import { LlmStructuredClassifier } from "../core/judge/llm-classifier.js";
import { DecisionModelDecisionsProvider } from "../core/judge/decision-model-provider.js";
import { DecisionsProvider, StructuredClassifier } from "../core/judge/todo-judge.js";
import type { LlmProfile } from "./config/app-config.js";

// 判定は verdict と 1 文の理由だけなので、出力トークンに上限を付けて料金の上振れを防ぐ。
// 256 では、入力が長いときにモデルが答える前に考え、上限を使い切って本文を返さないことがあった。
const MAX_JUDGMENT_OUTPUT_TOKENS = 1024;
// 思考を無効にする理由: 3 択と理由 1 文の判定に考える必要はなく、思考が出力トークンを使い切ると答えが返らないため。
const JUDGMENT_THINKING = { type: "disabled" } as const;

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
          Layer.provide(
            AnthropicLanguageModel.model(profile.model, { max_tokens: MAX_JUDGMENT_OUTPUT_TOKENS, thinking: JUDGMENT_THINKING }),
          ),
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

const DEFAULT_OPENAI_DECISIONS_MODEL = "gpt-6-luna";

/**
 * LLM Profile の decisions から DecisionsProvider を作る。decisions がなければ none で、TodoJudge は structured output に落とす。
 * アカウントごとに呼び、そのアカウントのジョブにだけ渡す。
 */
export const makeDecisionsProvider = Effect.fnUntraced(function* (profile: LlmProfile) {
  if (profile.decisions === undefined) return Option.none<DecisionsProvider["Service"]>();
  const secrets = yield* SecretStore;
  switch (profile.decisions.provider) {
    case "openai": {
      const apiKey = yield* secrets.require("llm.openai.api_key");
      const provider = yield* Effect.gen(function* () {
        return yield* DecisionsProvider;
      }).pipe(
        Effect.provide(
          DecisionModelDecisionsProvider.pipe(
            Layer.provide(OpenAiDecisionModel.layer({ model: profile.decisions.model ?? DEFAULT_OPENAI_DECISIONS_MODEL })),
            Layer.provide(OpenAiClient.layer({ apiKey })),
          ),
        ),
      );
      return Option.some(provider);
    }
    default:
      // Jev・Gemini Decisions は effect/ai の provider がないので、使うときに DecisionModel.make で足す
      return yield* new UnsupportedLlmProviderError({ provider: profile.decisions.provider });
  }
});
