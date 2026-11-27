import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { AiError, DecisionModel, LanguageModel } from "effect/ai";
import { dossierOf } from "../task/dossier.js";
import { conditionProbability, decomposeCondition, type RuleCondition, RuleConditionError } from "./rule-condition.js";

const replying = (json: unknown) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({ generateText: () => Effect.succeed([{ type: "text", text: JSON.stringify(json) }]), streamText: () => Stream.empty }),
  );

function deciding(answer: (options: DecisionModel.ProviderOptions) => Record<string, DecisionModel.ProviderAnswer>) {
  const calls: DecisionModel.ProviderOptions[] = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: (options) =>
        Effect.sync(() => {
          calls.push(options);
          return { answers: answer(options), usage: { inputTokens: 1, outputTokens: 0 } };
        }),
    }),
  );
  return { calls, layer };
}

const probabilities = (values: Record<string, number>) => () =>
  Object.fromEntries(Object.entries(values).map(([key, probability]) => [key, { _tag: "Probability" as const, probability }]));

const dossier = dossierOf({ id: 1, title: "README の誤字", brief: null, status: "needs_review", recurringTaskId: null }, [
  { role: "tracks", item: { source: "github:work", title: "README", url: "https://github.com/acme/app/pull/1", state: "open", author: null, fact: { trusted: ["作成者: @alice"], body: "タイトル: README の誤字を直す" } } },
]);

const OTHERS_PR: RuleCondition = {
  combine: "all",
  clauses: [
    { question: "紐づく事実に GitHub の PR があるか", expect: true, about: "metadata" },
    { question: "その PR の作成者は YutaUra か", expect: false, about: "metadata" },
    { question: "その PR はドキュメントの修正か", expect: true, about: "content" },
  ],
};

describe("decomposeCondition", () => {
  it.effect("条件を、アプリの情報で答える問いと内容を読んで答える問いに分けて返す", () =>
    Effect.gen(function* () {
      const result = yield* decomposeCondition("YutaUra 以外が作ったドキュメントの PR");

      assert.deepStrictEqual(result, OTHERS_PR);
    }).pipe(Effect.provide(replying(OTHERS_PR))));

  it.effect("問いが 1 つもない分け方は、ルールにできない理由を示すエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decomposeCondition("いい感じのもの"));

      assert.instanceOf(error, RuleConditionError);
    }).pipe(Effect.provide(replying({ combine: "all", clauses: [] }))));
});

describe("conditionProbability", () => {
  it.effect("アプリの情報で答える問いには、外の人が書いた文（title・本文）を渡さない", () => {
    const { calls, layer } = deciding(probabilities({ q0: 1, q1: 0, q2: 1 }));
    return Effect.gen(function* () {
      yield* conditionProbability(OTHERS_PR, dossier);

      const metadataCall = calls.find((call) => Object.keys(call.decisions).includes("q0"));
      const contentCall = calls.find((call) => Object.keys(call.decisions).includes("q2"));
      assert.notInclude(JSON.stringify(metadataCall?.state), "README の誤字を直す");
      assert.include(JSON.stringify(contentCall?.state), "README の誤字を直す");
    }).pipe(Effect.provide(layer));
  });

  it.effect("問いごとに期待どおりの確率を出し、いちばん低いものを条件の確率にする", () =>
    Effect.gen(function* () {
      const probability = yield* conditionProbability(OTHERS_PR, dossier);

      // q1 は「いいえ」が期待どおりなので 1 - 0.1 = 0.9。最小は q2 の 0.85
      assert.closeTo(probability ?? 0, 0.85, 1e-9);
    }).pipe(Effect.provide(deciding(probabilities({ q0: 0.95, q1: 0.1, q2: 0.85 })).layer)));

  it.effect("どれかの問いに答えが返らなければ、当てはまらないものとして undefined を返す（fail closed）", () =>
    Effect.gen(function* () {
      const probability = yield* conditionProbability(OTHERS_PR, dossier);

      assert.isUndefined(probability);
    }).pipe(Effect.provide(deciding(() => ({ q0: { _tag: "Probability", probability: 1 }, q1: { _tag: "Refusal" }, q2: { _tag: "Probability", probability: 1 } })).layer)));

  it.effect("どれか 1 つでよい条件は、いちばん高いものを条件の確率にする", () =>
    Effect.gen(function* () {
      const probability = yield* conditionProbability(
        { combine: "any", clauses: [{ question: "請求書か", expect: true, about: "content" }, { question: "領収書か", expect: true, about: "content" }] },
        dossier,
      );

      assert.closeTo(probability ?? 0, 0.9, 1e-9);
    }).pipe(Effect.provide(deciding(probabilities({ q0: 0.2, q1: 0.9 })).layer)));

  it.effect("内容を読む問いがなければ、Decisions を 1 回だけ呼ぶ", () => {
    const { calls, layer } = deciding(probabilities({ q0: 1 }));
    return Effect.gen(function* () {
      yield* conditionProbability({ combine: "all", clauses: [{ question: "PR があるか", expect: true, about: "metadata" }] }, dossier);

      assert.strictEqual(calls.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Decisions を呼べなければ失敗にする（当てはまらないと記録しない）", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(conditionProbability(OTHERS_PR, dossier));

      assert.instanceOf(error, AiError.AiError);
    }).pipe(
      Effect.provide(
        Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({ decide: () => Effect.fail(AiError.make({ module: "Test", method: "decide", reason: new AiError.RateLimitError({}) })) }),
        ),
      ),
    ));
});
