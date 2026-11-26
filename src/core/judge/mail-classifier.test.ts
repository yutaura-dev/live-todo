import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { type AiError, DecisionModel } from "effect/ai";
import { DecisionModelMailClassifier, MailClassifier } from "./mail-classifier.js";

function fakeDecisionModel(answer: () => Effect.Effect<Record<string, DecisionModel.ProviderAnswer>, AiError.AiError>) {
  const calls: DecisionModel.ProviderOptions[] = [];
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: (options) =>
        answer().pipe(
          Effect.map((answers) => {
            calls.push(options);
            return { answers, usage: { inputTokens: 10, outputTokens: 1 } };
          }),
        ),
    }),
  );
  return { calls, layer: DecisionModelMailClassifier.pipe(Layer.provide(model)) };
}

const classify = (request: { input: string; context: string }) =>
  Effect.gen(function* () {
    return yield* (yield* MailClassifier).classify(request);
  });

const answering = (answer: DecisionModel.ProviderAnswer) => fakeDecisionModel(() => Effect.succeed({ kind: answer }));

describe("MailClassifier（Decisions API でメールを仕分ける）", () => {
  it.effect("人からのメール・お知らせ・メルマガのうち、いちばん確率の高いものを確率つきで返す", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* classify({ input: "件名: 今週のおすすめ", context: "List-Unsubscribe: あり" }), {
        kind: "newsletter",
        probability: 0.9,
        method: "decisions",
      });
    }).pipe(Effect.provide(answering({ _tag: "Classify", label: "newsletter", probabilities: { personal: 0.05, notification: 0.05, newsletter: 0.9 } }).layer)));

  it.effect("確率が低い（0.6 未満）ときは、隠さない側（人からのメール）に倒す", () =>
    Effect.gen(function* () {
      assert.deepInclude(yield* classify({ input: "x", context: "" }), { kind: "personal", method: "fallback" });
    }).pipe(Effect.provide(answering({ _tag: "Classify", label: "newsletter", probabilities: { personal: 0.3, notification: 0.2, newsletter: 0.5 } }).layer)));

  it.effect("拒否されたら、隠さない側（人からのメール）に倒す（fail closed）", () =>
    Effect.gen(function* () {
      assert.deepInclude(yield* classify({ input: "x", context: "" }), { kind: "personal", method: "fallback" });
    }).pipe(Effect.provide(answering({ _tag: "Refusal" }).layer)));

  it.effect("メールの中身は評価対象に、ヘッダーなどアプリが書いた情報は指示の側に分けて渡す", () => {
    const model = answering({ _tag: "Classify", label: "personal", probabilities: { personal: 0.9, notification: 0.05, newsletter: 0.05 } });
    return Effect.gen(function* () {
      yield* classify({ input: "件名: 打ち合わせの件", context: "List-Unsubscribe: なし" });

      const [call] = model.calls;
      assert.include(JSON.stringify(call?.state), "件名: 打ち合わせの件");
      assert.notInclude(JSON.stringify(call?.state), "List-Unsubscribe");
      assert.include(JSON.stringify(call?.decisions["kind"]?.instructions), "List-Unsubscribe: なし");
    }).pipe(Effect.provide(model.layer));
  });
});
