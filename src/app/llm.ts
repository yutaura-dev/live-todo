import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiDecisionModel, OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Layer, Option, type Redacted, Schema } from "effect";
import { SecretStore } from "../core/config/secret-store.js";
import { ConservativeClassifier } from "../core/judge/conservative-classifier.js";
import { LlmStructuredClassifier } from "../core/judge/llm-classifier.js";
import { DecisionModelDecisionsProvider } from "../core/judge/decision-model-provider.js";
import { DecisionModelMailClassifier, MailClassifier } from "../core/judge/mail-classifier.js";
import { MicrosoftDecisionModel } from "../core/judge/microsoft-decision-model.js";
import { DecisionsProvider, StructuredClassifier, type TodoJudgeThresholds } from "../core/judge/todo-judge.js";
import type { LlmProfile } from "./config/app-config.js";

// 判定は verdict と 1 文の理由だけなので、出力トークンに上限を付けて料金の上振れを防ぐ。
// 256 では、入力が長いときにモデルが答える前に考え、上限を使い切って本文を返さないことがあった。
const MAX_JUDGMENT_OUTPUT_TOKENS = 1024;
// 思考を無効にする理由: 3 択と理由 1 文の判定に考える必要はなく、思考が出力トークンを使い切ると答えが返らないため。
const JUDGMENT_THINKING = { type: "disabled" } as const;
// OpenAI 系（Azure）の推論を切る理由も同じ。既定の推論レベルのままだと、考えた分の出力トークンにも料金がかかる
const JUDGMENT_REASONING = { effort: "none" } as const;

export class UnsupportedLlmProviderError extends Schema.TaggedError<UnsupportedLlmProviderError>()(
  "UnsupportedLlmProviderError",
  { provider: Schema.String },
) {}

const AZURE_API_KEY = "llm.azure-openai.api_key";

export class MissingAzureEndpointError extends Schema.TaggedError<MissingAzureEndpointError>()("MissingAzureEndpointError", {}) {}

// v1 API は OpenAI 互換なので OpenAiClient の接続先だけを変える。公式の REST 例の api-key ヘッダでなく Bearer にする理由:
// OpenAI SDK に API キーを渡す公式の手順と同じで、Authorization は既定で伏せ字にされる（api-key は対象外）ため
const azureClientLayer = Effect.fnUntraced(function* (profile: LlmProfile, apiKey: Redacted.Redacted<string>) {
  // 設定ファイルの検証でエンドポイントを必須にしているので、ここに来るのは検証を通さずに作った LLM Profile だけ
  if (profile.azure === undefined) return yield* new MissingAzureEndpointError();
  return OpenAiClient.layer({ apiKey, apiUrl: `${profile.azure.endpoint}/openai/v1` });
});

const buildClassifier = <E, R>(layer: Layer.Layer<StructuredClassifier, E, R>) =>
  Effect.gen(function* () {
    return yield* StructuredClassifier;
  }).pipe(Effect.provide(layer));

/**
 * LLM Profile から LanguageModel を作る。判定・ルールの条件の分解に使う。どの provider でも、思考・推論を切り、出力トークンに上限を付ける
 * （答えは短い構造化出力で、考えた分の出力トークンにも料金がかかるため）
 */
export const makeLanguageModel = Effect.fnUntraced(function* (profile: LlmProfile) {
  const secrets = yield* SecretStore;
  switch (profile.provider) {
    case "anthropic": {
      const apiKey = yield* secrets.require("llm.anthropic.api_key");
      return AnthropicLanguageModel.model(profile.model, { max_tokens: MAX_JUDGMENT_OUTPUT_TOKENS, thinking: JUDGMENT_THINKING }).pipe(
        Layer.provide(AnthropicClient.layer({ apiKey })),
      );
    }
    case "openai": {
      const apiKey = yield* secrets.require("llm.openai.api_key");
      return OpenAiLanguageModel.model(profile.model).pipe(Layer.provide(OpenAiClient.layer({ apiKey })));
    }
    case "azure-openai": {
      const apiKey = yield* secrets.require(AZURE_API_KEY);
      return OpenAiLanguageModel.model(profile.model, { max_output_tokens: MAX_JUDGMENT_OUTPUT_TOKENS, reasoning: JUDGMENT_REASONING }).pipe(
        Layer.provide(yield* azureClientLayer(profile, apiKey)),
      );
    }
    default:
      // none は LLM を使わない。Gemini（@effect/ai-google が v4 に未対応）・Bedrock は、使うときに足す
      return yield* new UnsupportedLlmProviderError({ provider: profile.provider });
  }
});

/** LLM Profile から StructuredClassifier を作る。アカウントごとに呼び、そのアカウントのジョブにだけ渡す */
export const makeStructuredClassifier = Effect.fnUntraced(function* (profile: LlmProfile) {
  if (profile.provider === "none") return yield* buildClassifier(ConservativeClassifier);
  return yield* buildClassifier(LlmStructuredClassifier.pipe(Layer.provide(yield* makeLanguageModel(profile))));
});

// Azure では deployment 名。Azure の手順書の例がモデル名と同じ deployment 名なので、同じ既定値にする
const DEFAULT_OPENAI_DECISIONS_MODEL = "gpt-6-luna";

// Foundry で deploy したときの既定の deployment 名
const DEFAULT_MICROSOFT_DECISION_DEPLOYMENT = "Decision-1.1";

/** Decisions を呼ぶ DecisionModel の Layer。decisions.provider ごとに接続先と API キーを決める */
const decisionModelLayer = Effect.fnUntraced(function* (profile: LlmProfile, decisions: NonNullable<LlmProfile["decisions"]>) {
  const secrets = yield* SecretStore;
  const model = OpenAiDecisionModel.layer({ model: decisions.model ?? DEFAULT_OPENAI_DECISIONS_MODEL });
  switch (decisions.provider) {
    case "openai":
      return model.pipe(Layer.provide(OpenAiClient.layer({ apiKey: yield* secrets.require("llm.openai.api_key") })));
    case "azure-openai":
      return model.pipe(Layer.provide(yield* azureClientLayer(profile, yield* secrets.require(AZURE_API_KEY))));
    case "microsoft-decision": {
      const apiKey = yield* secrets.require(AZURE_API_KEY);
      if (profile.azure === undefined) return yield* new MissingAzureEndpointError();
      return MicrosoftDecisionModel.layer({ endpoint: profile.azure.endpoint, deployment: decisions.model ?? DEFAULT_MICROSOFT_DECISION_DEPLOYMENT, apiKey });
    }
    default:
      // Jev・Gemini Decisions は effect/ai の provider がないので、使うときに DecisionModel.make で足す
      return yield* new UnsupportedLlmProviderError({ provider: decisions.provider });
  }
});

/** LLM Profile の decisions から DecisionModel を作る。ルールの条件の判定・「何をする」の読み取りに使う */
export const makeDecisionModel = Effect.fnUntraced(function* (profile: LlmProfile) {
  if (profile.decisions === undefined) return yield* new UnsupportedLlmProviderError({ provider: `${profile.provider}（decisions なし）` });
  return yield* decisionModelLayer(profile, profile.decisions);
});

/**
 * LLM Profile の decisions から DecisionsProvider を作る。decisions がなければ none で、TodoJudge は structured output に落とす。
 * アカウントごとに呼び、そのアカウントのジョブにだけ渡す。
 */
export const makeDecisionsProvider = Effect.fnUntraced(function* (profile: LlmProfile) {
  if (profile.decisions === undefined) return Option.none<DecisionsProvider["Service"]>();
  const layer = yield* decisionModelLayer(profile, profile.decisions);
  const provider = yield* Effect.gen(function* () {
    return yield* DecisionsProvider;
  }).pipe(Effect.provide(DecisionModelDecisionsProvider.pipe(Layer.provide(layer))));
  return Option.some(provider);
});

/** LLM Profile の decisions で、メールを人・お知らせ・メルマガに仕分ける。decisions がなければ作れない（Gmail はこれで仕分ける） */
export const makeMailClassifier = Effect.fnUntraced(function* (profile: LlmProfile) {
  if (profile.decisions === undefined) return yield* new UnsupportedLlmProviderError({ provider: `${profile.provider}（decisions なし）` });
  const layer = yield* decisionModelLayer(profile, profile.decisions);
  return yield* Effect.gen(function* () {
    return yield* MailClassifier;
  }).pipe(Effect.provide(DecisionModelMailClassifier.pipe(Layer.provide(layer))));
});

/**
 * Decisions の閾値の既定値。対象外にするのは確率 0.05 未満だけにする。
 * 本物で試したとき、Haiku が todo と判定した自分の PR に Decisions が 0.2 前後の確率を付けた。確率の当たり具合を
 * 仕分けの結果で確かめるまでは、黙って隠さず要確認に回す（docs/architecture.md の「判定の閾値」）。
 */
export const DEFAULT_DECISIONS_THRESHOLDS: TodoJudgeThresholds = { todo: 0.8, review: 0.05 };

export const judgeThresholdsFor = (profile: LlmProfile): TodoJudgeThresholds =>
  profile.decisions?.thresholds ?? DEFAULT_DECISIONS_THRESHOLDS;
