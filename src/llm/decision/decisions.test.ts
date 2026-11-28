import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";
import { answered, unanswered } from "../shared/answer.js";
import { Decisions, decisionsFromModel } from "./decisions.js";
import { defineQuestion } from "./question.js";

const question = defineQuestion({
  purpose: "test.is-urgent",
  version: 3,
  input: Schema.Struct({ text: Schema.String }),
  decisions: () => ({
    urgent: Decision.probability({ instructions: "急ぎか" }),
    kind: Decision.classify({ instructions: "種類", criteria: { a: null, b: null } }),
  }),
});

function modelAnswering(answer: () => Effect.Effect<Record<string, DecisionModel.ProviderAnswer>, AiError.AiError>) {
  const calls: DecisionModel.ProviderOptions[] = [];
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: (options) =>
        answer().pipe(
          Effect.map((answers) => {
            calls.push(options);
            return { answers, usage: { inputTokens: 12, outputTokens: 2 }, modelId: "decisions-test" };
          }),
        ),
    }),
  );
  return { calls, layer: decisionsFromModel.pipe(Layer.provide(model)) };
}

const ask = Effect.gen(function* () {
  return yield* (yield* Decisions).ask(question, { text: "今日中に返事がほしい" });
});

describe("Decisions（確率付きの判定を、問いの定義から 1 回のリクエストで聞く）", () => {
  it.effect("問いごとの答えと、問いの版・確率の記録を返す", () => {
    const fake = modelAnswering(() =>
      Effect.succeed({ urgent: { _tag: "Probability", probability: 0.9 }, kind: { _tag: "Classify", label: "a", probabilities: { a: 0.7, b: 0.3 } } }),
    );
    return Effect.gen(function* () {
      const result = yield* ask;
      assert.deepStrictEqual(result.answers.urgent, answered({ probability: 0.9 }));
      assert.deepStrictEqual(result.record, {
        role: "Decisions",
        purpose: "test.is-urgent",
        version: 3,
        modelId: "decisions-test",
        answers: { urgent: { _tag: "Answered", probabilities: { true: 0.9 } }, kind: { _tag: "Answered", probabilities: { a: 0.7, b: 0.3 } } },
        usage: { inputTokens: 12, outputTokens: 2 },
      });
      assert.deepStrictEqual(fake.calls[0]?.state, { text: "今日中に返事がほしい" });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("1 つの問いを断られても、ほかの問いの答えは残し、断られた問いは答えなかったにする", () =>
    Effect.gen(function* () {
      const result = yield* ask;
      assert.deepStrictEqual(result.answers.urgent, unanswered("Refused"));
      assert.strictEqual(result.answers.kind?._tag, "Answered");
    }).pipe(
      Effect.provide(
        modelAnswering(() => Effect.succeed({ urgent: { _tag: "Refusal" }, kind: { _tag: "Classify", label: "b", probabilities: { a: 0.2, b: 0.8 } } })).layer,
      ),
    ));

  it.effect("答えが返らなかった問いは、否定ではなく答えなかった（Missing）にする", () =>
    Effect.gen(function* () {
      const result = yield* ask;
      assert.deepStrictEqual(result.answers.urgent, unanswered("Missing"));
    }).pipe(Effect.provide(modelAnswering(() => Effect.succeed({ kind: { _tag: "Classify", label: "a", probabilities: { a: 0.6, b: 0.4 } } })).layer)));

  it.effect("リクエストごと断られたら、すべての問いを答えなかった（Refused）にする", () =>
    Effect.gen(function* () {
      const result = yield* ask;
      assert.deepStrictEqual(result.answers, { urgent: unanswered("Refused"), kind: unanswered("Refused") });
    }).pipe(
      Effect.provide(
        modelAnswering(() => Effect.fail(new AiError.AiError({ module: "test", method: "decide", reason: new AiError.ContentPolicyError({ description: "x" }) }))).layer,
      ),
    ));

  it.effect("AI に届かなかったら、AiUnreachableError で失敗する（次の同期でやり直す）", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(ask);
      assert.deepStrictEqual({ tag: error._tag, role: error.role, purpose: error.purpose, reason: error.reason }, {
        tag: "AiUnreachableError",
        role: "Decisions",
        purpose: "test.is-urgent",
        reason: "RateLimit",
      });
    }).pipe(
      Effect.provide(modelAnswering(() => Effect.fail(new AiError.AiError({ module: "test", method: "decide", reason: new AiError.RateLimitError({}) }))).layer),
    ));
});
