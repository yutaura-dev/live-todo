import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Config, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { NodeFileSystem } from "@effect/platform-node";
import { DecisionModel, LanguageModel } from "effect/ai";
import { MicrosoftDecisionModel } from "../../src/core/judge/microsoft-decision-model.js";

const Profile = Schema.Struct({
  model: Schema.String,
  azure: Schema.Struct({ endpoint: Schema.String }),
  decisions: Schema.Struct({ model: Schema.String }),
});

/** config.json の既定の LLM Profile（Azure + Microsoft-Decision）から、Decisions と LLM の Layer を作る */
export const SpikeModels = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = JSON.parse(yield* fs.readFileString(yield* Config.String("LIVE_TODO_CONFIG").pipe(Config.withDefault("./config.json"))));
    const profile = Schema.decodeUnknownSync(Profile)(config.llmProfiles[config.defaultLlmProfile]);
    const apiKey = yield* Config.Redacted("LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY");
    const decisions = MicrosoftDecisionModel.layer({ endpoint: profile.azure.endpoint, deployment: profile.decisions.model, apiKey });
    const language = OpenAiLanguageModel.model(profile.model, { max_output_tokens: 1024, reasoning: { effort: "none" } }).pipe(
      Layer.provide(OpenAiClient.layer({ apiKey, apiUrl: `${profile.azure.endpoint}/openai/v1` })),
    );
    return Layer.mergeAll(decisions, language);
  }),
).pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, NodeFileSystem.layer)), Layer.provideMerge(FetchHttpClient.layer));

export type Models = DecisionModel.DecisionModel | LanguageModel.LanguageModel;
export { Redacted };
