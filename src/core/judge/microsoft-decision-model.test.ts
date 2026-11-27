import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted, Result, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";
import { MicrosoftDecisionModel } from "./microsoft-decision-model.js";

// 本物の Decision-1.1 に、ダミーの通知文で確率 1 問と選択 1 問を送ったときの応答（2026-11-27）
const ANSWERED = {
  model: "microsoft-decision-1.1",
  answers: {
    kind: {
      type: "choice",
      choice: "review",
      confidence: 0.9919271859020724,
      probabilities: { mention: 0.0018188483366162324, other: 0.0035630277286687988, review: 0.9946181239347149 },
    },
    todo: { type: "noul", noul: 0.7565775629592861 },
  },
  usage: { input_tokens: 100, output_tokens: 2 },
};

const Definition = Decision.make({
  input: Schema.Struct({ item: Schema.String }),
  decisions: {
    todo: Decision.probability({ instructions: "対応が要るか", criteria: { true: "要る", false: "要らない" } }),
    kind: Decision.classify({ instructions: "種類はどれか", criteria: { review: "レビュー依頼", mention: "メンション", other: null } }),
  },
});

type Recorded = { url: string; apiKey: string | undefined; authorization: string | undefined; body: unknown };

const respondWith = (status: number, body: string) => {
  const requests: Recorded[] = [];
  const http = HttpClient.make((request, url) => {
    requests.push({
      url: url.toString(),
      apiKey: request.headers["api-key"],
      authorization: request.headers["authorization"],
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status, headers: { "content-type": "application/json" } })));
  });
  return { http, requests };
};

const decide = (http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel;
    return yield* model.decideSettled(Definition, { input: { item: "PR #12 のレビュー依頼" } });
  }).pipe(
    Effect.provide(MicrosoftDecisionModel.layer({ endpoint: "https://acme.openai.azure.com", deployment: "Decision-1.1", apiKey: Redacted.make("az-test") })),
    Effect.provideService(HttpClient.HttpClient, http),
  );

describe("MicrosoftDecisionModel", () => {
  it.effect("リソースの systemone に、deployment 名と名前付きの質問を api-key ヘッダで送る", () => {
    const { http, requests } = respondWith(200, JSON.stringify(ANSWERED));
    return Effect.gen(function* () {
      yield* decide(http);

      assert.strictEqual(requests[0]?.url, "https://acme.openai.azure.com/providers/microsoft/v1/systemone");
      assert.strictEqual(requests[0]?.apiKey, "az-test");
      assert.isUndefined(requests[0]?.authorization);
      assert.deepStrictEqual(requests[0]?.body, {
        model: "Decision-1.1",
        state: { item: "PR #12 のレビュー依頼" },
        questions: {
          todo: { type: "noul", instructions: "対応が要るか", criteria: { true: "要る", false: "要らない" } },
          kind: { type: "choice", instructions: "種類はどれか", criteria: { review: "レビュー依頼", mention: "メンション", other: "other" } },
        },
      });
    });
  });

  it.effect("noul の答えを、true の確率として返す", () =>
    Effect.gen(function* () {
      const { outcomes } = yield* decide(respondWith(200, JSON.stringify(ANSWERED)).http);

      assert.isTrue(Result.isSuccess(outcomes.todo));
      if (Result.isSuccess(outcomes.todo)) assert.closeTo(outcomes.todo.success.probability, 0.7566, 1e-4);
    }));

  it.effect("choice の答えを、選んだ選択肢と選択肢ごとの確率として返す", () =>
    Effect.gen(function* () {
      const { outcomes, usage } = yield* decide(respondWith(200, JSON.stringify(ANSWERED)).http);

      assert.isTrue(Result.isSuccess(outcomes.kind));
      if (Result.isSuccess(outcomes.kind)) {
        assert.strictEqual(outcomes.kind.success.label, "review");
        assert.closeTo(outcomes.kind.success.probabilities.review, 0.9946, 1e-4);
      }
      assert.strictEqual(usage.inputTokens, 100);
    }));

  it.effect("知らない形の答えは、答えがなかったものとして扱う（否定の答えと取り違えない）", () =>
    Effect.gen(function* () {
      const body = { ...ANSWERED, answers: { todo: { type: "refusal" }, kind: ANSWERED.answers.kind } };

      const { outcomes } = yield* decide(respondWith(200, JSON.stringify(body)).http);

      assert.isTrue(Result.isFailure(outcomes.todo));
      assert.isTrue(Result.isSuccess(outcomes.kind));
    }));

  it.effect("API キーが通らなければ、認証のエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decide(respondWith(401, JSON.stringify({ error: { code: "401" } })).http));

      assert.strictEqual(error.reason._tag, "AuthenticationError");
    }));

  it.effect("deployment がなければ、エラーに API の説明を含める（deployment 名の間違いに気づけるように）", () =>
    Effect.gen(function* () {
      const body = { error: { code: "DeploymentNotFound", message: "The API deployment x does not exist." } };

      const error = yield* Effect.flip(decide(respondWith(404, JSON.stringify(body)).http));

      assert.include(error.message, "DeploymentNotFound");
    }));

  it.effect("応答が読めない形なら、応答の不正として失敗する", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decide(respondWith(200, JSON.stringify({ unexpected: true })).http));

      assert.strictEqual(error.reason._tag, "InvalidResponseError");
    }));

  it.effect("エラーに API キーを含めない", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decide(respondWith(500, "{}").http));

      assert.notInclude(JSON.stringify(error), "az-test");
      assert.notInclude(String(error), "az-test");
    }));
});
