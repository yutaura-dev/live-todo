import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import { ConservativeClassifier } from "./conservative-classifier.js";
import { DecisionModelDecisionsProvider } from "./decision-model-provider.js";
import { DecisionsProvider, JudgeRequestError, makeTodoJudge } from "./todo-judge.js";

const QUESTION = "この通知は、自分が対応すべきタスクか？";

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
  return { calls, layer: DecisionModelDecisionsProvider.pipe(Layer.provide(model)) };
}

const answering = (answers: Record<string, DecisionModel.ProviderAnswer>) => fakeDecisionModel(() => Effect.succeed(answers));

const judgePredicate = (request: { input: string; question: string; context?: string }) =>
  Effect.gen(function* () {
    return yield* (yield* DecisionsProvider).judgePredicate(request);
  });

describe("DecisionModelDecisionsProvider", () => {
  it.effect("DecisionModel が返した確率を predicate の答えとして返す", () =>
    Effect.gen(function* () {
      const answer = yield* judgePredicate({ input: "レビューお願いします", question: QUESTION });

      assert.deepStrictEqual(answer, { type: "predicate", probability: 0.9 });
    }).pipe(Effect.provide(answering({ todo: { _tag: "Probability", probability: 0.9 } }).layer)));

  it.effect("回答を拒否されたら refusal を返す", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* judgePredicate({ input: "...", question: QUESTION }), { type: "refusal" });
    }).pipe(Effect.provide(answering({ todo: { _tag: "Refusal" } }).layer)));

  it.effect("答えが返らなかったときも refusal として扱い、対象外にはしない", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* judgePredicate({ input: "...", question: QUESTION }), { type: "refusal" });
    }).pipe(Effect.provide(answering({}).layer)));

  it.effect("評価対象は input に入れ、質問と信頼できる情報は instructions に入れる", () => {
    const model = answering({ todo: { _tag: "Probability", probability: 0.5 } });
    return Effect.gen(function* () {
      yield* judgePredicate({ input: "タイトル: Login fails", question: QUESTION, context: "あなたの GitHub アカウント: @YutaUra" });

      const [call] = model.calls;
      const instructions = JSON.stringify(call?.decisions["todo"]?.instructions);
      assert.include(JSON.stringify(call?.state), "タイトル: Login fails");
      assert.notInclude(JSON.stringify(call?.state), "@YutaUra");
      assert.include(instructions, QUESTION);
      assert.include(instructions, "@YutaUra");
    }).pipe(Effect.provide(model.layer));
  });

  it.effect("レート制限などの失敗は JudgeRequestError にして、同期をやり直させる", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(judgePredicate({ input: "...", question: QUESTION }));

      assert.instanceOf(error, JudgeRequestError);
    }).pipe(
      Effect.provide(
        fakeDecisionModel(() =>
          Effect.fail(new AiError.AiError({ module: "Test", method: "decide", reason: new AiError.RateLimitError({}) })),
        ).layer,
      ),
    ));

  it.effect("TodoJudge に入れると、確率に閾値をかけて判定する", () =>
    Effect.gen(function* () {
      const judge = yield* makeTodoJudge({
        rules: [],
        describe: (value: string) => Effect.succeed({ input: value }),
        question: QUESTION,
        thresholds: { todo: 0.8, review: 0.4 },
      });

      const result = yield* judge("明日までにレビューしてください");

      assert.deepStrictEqual(result, { verdict: "todo", method: "decisions", probability: 0.85 });
    }).pipe(
      Effect.provide(Layer.mergeAll(answering({ todo: { _tag: "Probability", probability: 0.85 } }).layer, ConservativeClassifier)),
    ));
});
