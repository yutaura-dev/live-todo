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

  it.effect("お知らせかメルマガかで確率が割れても、人からのメールの確率が低ければ（0.25 以下）、高いほうに仕分ける", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* classify({ input: "x", context: "" }), { kind: "notification", probability: 0.5, method: "decisions" });
    }).pipe(Effect.provide(answering({ _tag: "Classify", label: "notification", probabilities: { personal: 0.1, notification: 0.5, newsletter: 0.4 } }).layer)));

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

  it.effect("対応を求めているかを、確率で返す（メルマガでも住所の確認などを求めることがある）", () => {
    const model = fakeDecisionModel(() => Effect.succeed({ action: { _tag: "Probability", probability: 0.7 } }));
    return Effect.gen(function* () {
      const answer = yield* (yield* MailClassifier).needsAction({ input: "件名: ご住所確認のお願い", context: "List-Unsubscribe: あり" });
      assert.deepInclude(answer, { probability: 0.7, method: "decisions" });
      assert.include(JSON.stringify(model.calls[0]?.state), "ご住所確認");
      assert.notInclude(JSON.stringify(model.calls[0]?.state), "List-Unsubscribe");
    }).pipe(Effect.provide(model.layer));
  });

  it.effect("対応を求めているかの判定が返らなければ、求めているものとして扱う（読む側に倒す）", () =>
    Effect.gen(function* () {
      assert.deepInclude(yield* (yield* MailClassifier).needsAction({ input: "x", context: "" }), { probability: undefined, method: "fallback" });
    }).pipe(Effect.provide(fakeDecisionModel(() => Effect.succeed({ action: { _tag: "Refusal" } })).layer)));

  it.effect("対応が要るかと同じ呼び出しで、メールの用件（請求・配送・宣伝など）も確率の高いものを返す", () => {
    const model = fakeDecisionModel(() =>
      Effect.succeed({
        action: { _tag: "Probability", probability: 0.1 },
        topic: { _tag: "Classify", label: "billing", probabilities: { billing: 0.8, account: 0.05, product: 0.05, contract: 0.02, shipping: 0.02, promotion: 0.02, news: 0.02, other: 0.02 } },
      }),
    );
    return Effect.gen(function* () {
      const answer = yield* (yield* MailClassifier).needsAction({ input: "件名: 請求書", context: "" });
      assert.strictEqual(answer.topic, "billing");
      assert.lengthOf(model.calls, 1);
      assert.containsAllKeys(model.calls[0]!.decisions, ["action", "topic"]);
    }).pipe(Effect.provide(model.layer));
  });

  it.effect("用件の確率が低いか答えが返らなければ「その他」にする", () =>
    Effect.gen(function* () {
      const answer = yield* (yield* MailClassifier).needsAction({ input: "x", context: "" });
      assert.strictEqual(answer.topic, "other");
    }).pipe(
      Effect.provide(
        fakeDecisionModel(() =>
          Effect.succeed({
            action: { _tag: "Probability", probability: 0.1 },
            topic: { _tag: "Classify", label: "billing", probabilities: { billing: 0.3, account: 0.1, product: 0.1, contract: 0.1, shipping: 0.1, promotion: 0.1, news: 0.1, other: 0.1 } },
          }),
        ).layer,
      ),
    ));

  it.effect("利用者が言葉で書いた条件に当てはまるかを、確率で返す（条件は指示の側、メールは評価対象に入れる）", () => {
    const model = fakeDecisionModel(() => Effect.succeed({ condition: { _tag: "Probability", probability: 0.93 } }));
    return Effect.gen(function* () {
      const answer = yield* (yield* MailClassifier).matchesCondition({ input: "件名: Your invoice", context: "Gmail のカテゴリ: 新着", condition: "請求書に関するメール" });
      assert.deepStrictEqual(answer, { probability: 0.93 });
      const call = model.calls[0]!;
      assert.include(JSON.stringify(call.state), "Your invoice");
      assert.include(JSON.stringify(call.decisions["condition"]?.instructions), "請求書に関するメール");
    }).pipe(Effect.provide(model.layer));
  });

  it.effect("条件の判定が返らなければ、確率なし（当てない）", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* (yield* MailClassifier).matchesCondition({ input: "x", context: "", condition: "請求書" }), { probability: undefined });
    }).pipe(Effect.provide(fakeDecisionModel(() => Effect.succeed({ condition: { _tag: "Refusal" } })).layer)));

  it.effect("「何をする」の文を、既読・アーカイブ・ラベル（候補から選ぶ）・できない操作の確率に分けて、1 回の呼び出しで聞く", () => {
    const model = fakeDecisionModel(() =>
      Effect.succeed({
        markRead: { _tag: "Probability", probability: 0.95 },
        archive: { _tag: "Probability", probability: 0.05 },
        addLabel: { _tag: "Probability", probability: 0.9 },
        label: { _tag: "Classify", label: "l0", probabilities: { l0: 0.9, l1: 0.05, none: 0.05 } },
        unsupported: { _tag: "Probability", probability: 0.02 },
      }),
    );
    return Effect.gen(function* () {
      const answer = yield* (yield* MailClassifier).interpretActions({ instruction: "レシート ラベルをつけて既読にする", labels: ["レシート", "仕事"] });
      assert.deepStrictEqual(answer, { markRead: 0.95, archive: 0.05, addLabel: 0.9, label: "レシート", unsupported: 0.02 });
      assert.lengthOf(model.calls, 1);
      assert.include(JSON.stringify(model.calls[0]!.state), "レシート ラベルをつけて既読にする");
    }).pipe(Effect.provide(model.layer));
  });
});
