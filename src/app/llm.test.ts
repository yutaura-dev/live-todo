import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { LanguageModel } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { EnvSecretStore, MissingSecretError } from "../core/config/secret-store.js";
import { Option } from "effect";
import type { LlmProfile } from "./config/app-config.js";
import { judgeThresholdsFor, makeDecisionModel, makeDecisionsProvider, makeLanguageModel, makeMailClassifier, makeStructuredClassifier, UnsupportedLlmProviderError } from "./llm.js";

const AZURE_PROFILE: LlmProfile = { provider: "azure-openai", model: "my-gpt-deployment", azure: { endpoint: "https://acme.openai.azure.com" } };
const AZURE_DECISIONS_PROFILE: LlmProfile = { provider: "none", model: "-", azure: { endpoint: "https://acme.openai.azure.com" }, decisions: { provider: "azure-openai" } };

const recordingHttp = () => {
  const requests: { url: string; authorization: string | undefined; body: unknown }[] = [];
  const http = HttpClient.make((request, url) => {
    requests.push({
      url: url.toString(),
      authorization: request.headers["authorization"],
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 })));
  });
  return { http, requests };
};

const withHttp = (http: HttpClient.HttpClient, env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(EnvSecretStore),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    );

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

  it.effect("Anthropic への判定のリクエストでは思考を無効にし、出力トークンの上限を付ける", () => {
    const bodies: unknown[] = [];
    const http = HttpClient.make((request) => {
      if (request.body._tag === "Uint8Array") bodies.push(JSON.parse(new TextDecoder().decode(request.body.body)));
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 })));
    });
    return Effect.gen(function* () {
      const classifier = yield* makeStructuredClassifier({ provider: "anthropic", model: "claude-haiku-5-5" });

      yield* Effect.exit(classifier.classifyTodo({ input: "x", question: "q" }));

      assert.deepInclude(bodies[0], { model: "claude-haiku-5-5", max_tokens: 1024, thinking: { type: "disabled" } });
    }).pipe(
      Effect.provide(EnvSecretStore),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { LIVE_TODO_SECRET_LLM_ANTHROPIC_API_KEY: "sk-test" } }),
      ),
    );
  });

  it.effect("Azure OpenAI の API キーがなければ、どのキーがないかを示すエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeStructuredClassifier(AZURE_PROFILE));

      assert.instanceOf(error, MissingSecretError);
      assert.strictEqual(error.key, "llm.azure-openai.api_key");
    }).pipe(withEnv({})));

  it.effect("Azure OpenAI では、リソースの v1 API に deployment 名をモデルとして送る", () => {
    const { http, requests } = recordingHttp();
    return Effect.gen(function* () {
      const classifier = yield* makeStructuredClassifier(AZURE_PROFILE);

      yield* Effect.exit(classifier.classifyTodo({ input: "x", question: "q" }));

      assert.strictEqual(requests[0]?.url, "https://acme.openai.azure.com/openai/v1/responses");
      assert.strictEqual(requests[0]?.authorization, "Bearer az-test");
      assert.deepInclude(requests[0]?.body, { model: "my-gpt-deployment" });
    }).pipe(withHttp(http, { LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY: "az-test" }));
  });

  it.effect("Azure OpenAI への判定のリクエストでは推論を切り、出力トークンの上限を付ける", () => {
    const { http, requests } = recordingHttp();
    return Effect.gen(function* () {
      const classifier = yield* makeStructuredClassifier(AZURE_PROFILE);

      yield* Effect.exit(classifier.classifyTodo({ input: "x", question: "q" }));

      assert.deepInclude(requests[0]?.body, { reasoning: { effort: "none" }, max_output_tokens: 1024 });
    }).pipe(withHttp(http, { LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY: "az-test" }));
  });

  it.effect("まだ対応していない provider は、起動時にエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeStructuredClassifier({ provider: "gemini", model: "gemini-x" }));

      assert.instanceOf(error, UnsupportedLlmProviderError);
      assert.strictEqual(error.provider, "gemini");
    }).pipe(withEnv({})));
});


describe("makeDecisionsProvider", () => {
  it.effect("LLM Profile に decisions がなければ none（structured output で判定する）", () =>
    Effect.gen(function* () {
      const provider = yield* makeDecisionsProvider({ provider: "anthropic", model: "claude-haiku-5-5" });

      assert.isTrue(Option.isNone(provider));
    }).pipe(withEnv({})));

  it.effect("OpenAI の Decisions を使うのに API キーがなければ、どのキーがないかを示すエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeDecisionsProvider({ provider: "none", model: "-", decisions: { provider: "openai" } }));

      assert.instanceOf(error, MissingSecretError);
      assert.strictEqual(error.key, "llm.openai.api_key");
    }).pipe(withEnv({})));

  it.effect("OpenAI の Decisions を、既定のモデル gpt-6-luna で呼ぶ", () => {
    const requests: { path: string; body: unknown }[] = [];
    const http = HttpClient.make((request, url) => {
      requests.push({
        path: url.pathname,
        body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 })));
    });
    return Effect.gen(function* () {
      const provider = yield* makeDecisionsProvider({ provider: "none", model: "-", decisions: { provider: "openai" } });

      yield* Effect.exit(Option.getOrThrow(provider).judgePredicate({ input: "x", question: "q" }));

      assert.match(requests[0]?.path ?? "", /decisions$/);
      assert.deepInclude(requests[0]?.body, { model: "gpt-6-luna" });
    }).pipe(
      Effect.provide(EnvSecretStore),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { LIVE_TODO_SECRET_LLM_OPENAI_API_KEY: "sk-test" } })),
    );
  });

  it.effect("Azure OpenAI の Decisions を、既定の deployment 名 gpt-6-luna で呼ぶ", () => {
    const { http, requests } = recordingHttp();
    return Effect.gen(function* () {
      const provider = yield* makeDecisionsProvider(AZURE_DECISIONS_PROFILE);

      yield* Effect.exit(Option.getOrThrow(provider).judgePredicate({ input: "x", question: "q" }));

      assert.strictEqual(requests[0]?.url, "https://acme.openai.azure.com/openai/v1/decisions");
      assert.strictEqual(requests[0]?.authorization, "Bearer az-test");
      assert.deepInclude(requests[0]?.body, { model: "gpt-6-luna" });
    }).pipe(withHttp(http, { LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY: "az-test" }));
  });

  it.effect("Microsoft-Decision を、同じ Azure のリソースで既定の deployment 名 Decision-1.1 で呼ぶ", () => {
    const requests: { url: string; apiKey: string | undefined; body: unknown }[] = [];
    const http = HttpClient.make((request, url) => {
      requests.push({
        url: url.toString(),
        apiKey: request.headers["api-key"],
        body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 })));
    });
    return Effect.gen(function* () {
      const provider = yield* makeDecisionsProvider({ ...AZURE_DECISIONS_PROFILE, decisions: { provider: "microsoft-decision" } });

      yield* Effect.exit(Option.getOrThrow(provider).judgePredicate({ input: "x", question: "q" }));

      assert.strictEqual(requests[0]?.url, "https://acme.openai.azure.com/providers/microsoft/v1/systemone");
      assert.strictEqual(requests[0]?.apiKey, "az-test");
      assert.deepInclude(requests[0]?.body, { model: "Decision-1.1" });
    }).pipe(withHttp(http, { LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY: "az-test" }));
  });

  it.effect("まだ対応していない Decisions provider は、起動時にエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeDecisionsProvider({ provider: "none", model: "-", decisions: { provider: "jev" } }));

      assert.instanceOf(error, UnsupportedLlmProviderError);
      assert.strictEqual(error.provider, "jev");
    }).pipe(withEnv({})));
});

describe("makeMailClassifier", () => {
  it.effect("LLM Profile に decisions がなければ、作れない理由を示すエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeMailClassifier({ provider: "anthropic", model: "claude-haiku-5-5" }));

      assert.instanceOf(error, UnsupportedLlmProviderError);
    }).pipe(withEnv({})));

  it.effect("OpenAI の Decisions で、メールの種類を分類させる", () => {
    const requests: { path: string; body: unknown }[] = [];
    const http = HttpClient.make((request, url) => {
      requests.push({ path: url.pathname, body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined });
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 })));
    });
    return Effect.gen(function* () {
      const classifier = yield* makeMailClassifier({ provider: "none", model: "-", decisions: { provider: "openai" } });

      yield* Effect.exit(classifier.classify({ input: "件名: x", context: "" }));

      assert.match(requests[0]?.path ?? "", /decisions$/);
      assert.deepInclude(requests[0]?.body, { model: "gpt-6-luna" });
    }).pipe(
      Effect.provide(EnvSecretStore),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { LIVE_TODO_SECRET_LLM_OPENAI_API_KEY: "sk-test" } })),
    );
  });

  it.effect("Azure OpenAI の Decisions で、メールの種類を分類させる", () => {
    const { http, requests } = recordingHttp();
    return Effect.gen(function* () {
      const classifier = yield* makeMailClassifier(AZURE_DECISIONS_PROFILE);

      yield* Effect.exit(classifier.classify({ input: "件名: x", context: "" }));

      assert.strictEqual(requests[0]?.url, "https://acme.openai.azure.com/openai/v1/decisions");
    }).pipe(withHttp(http, { LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY: "az-test" }));
  });
});

describe("judgeThresholdsFor", () => {
  it("Decisions の閾値を設定していなければ、対象外にするのは確率 0.05 未満だけにする（確率の当たり具合を確かめる前に黙って隠さない）", () => {
    assert.deepStrictEqual(judgeThresholdsFor({ provider: "none", model: "-", decisions: { provider: "openai" } }), { todo: 0.8, review: 0.05 });
  });

  it("設定した閾値があればそれを使う", () => {
    assert.deepStrictEqual(
      judgeThresholdsFor({ provider: "none", model: "-", decisions: { provider: "openai", thresholds: { todo: 0.7, review: 0.3 } } }),
      { todo: 0.7, review: 0.3 },
    );
  });
});

describe("makeLanguageModel / makeDecisionModel（ルールの分解と判定に使う）", () => {
  it.effect("LLM を使わない LLM Profile では、LanguageModel を作れない理由を示すエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeLanguageModel({ provider: "none", model: "-" }));

      assert.instanceOf(error, UnsupportedLlmProviderError);
    }).pipe(withEnv({})));

  it.effect("decisions のない LLM Profile では、DecisionModel を作れない理由を示すエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeDecisionModel({ provider: "anthropic", model: "claude-haiku-5-5" }));

      assert.instanceOf(error, UnsupportedLlmProviderError);
    }).pipe(withEnv({})));

  it.effect("Azure OpenAI の LLM Profile から、推論を切った LanguageModel を作る", () => {
    const { http, requests } = recordingHttp();
    return Effect.gen(function* () {
      const layer = yield* makeLanguageModel(AZURE_PROFILE);

      yield* Effect.exit(
        Effect.gen(function* () {
          const model = yield* LanguageModel.LanguageModel;
          return yield* model.generateText({ prompt: "x" });
        }).pipe(Effect.provide(layer)),
      );

      assert.deepInclude(requests[0]?.body, { model: "my-gpt-deployment", reasoning: { effort: "none" } });
    }).pipe(withHttp(http, { LIVE_TODO_SECRET_LLM_AZURE_OPENAI_API_KEY: "az-test" }));
  });
});
