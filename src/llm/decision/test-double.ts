import { Effect, Layer } from "effect";
import type { Decision } from "effect/ai";
import { type Answer, answered } from "../shared/answer.js";
import type { AiUnreachableError } from "../shared/errors.js";
import type { AnswerRecord } from "../shared/record.js";
import { type DecisionResult, Decisions } from "./decisions.js";
import type { TextDecision } from "./question.js";

type Scripted = Record<string, Answer<Decision.Answer<TextDecision>>>;
type Script = Readonly<Record<string, (input: unknown) => Scripted | Effect.Effect<Scripted, AiUnreachableError>>>;

export const probability = (p: number) => answered({ probability: p });
export const classified = <L extends string>(probabilities: Record<L, number>) => {
  const label = (Object.entries(probabilities) as Array<[L, number]>).sort((a, b) => b[1] - a[1])[0]![0];
  return answered({ label, probabilities });
};

/**
 * テスト用の Decisions（テストから実 API を呼ばないため）。問いの ID ごとに答えを決める。
 * 決めていない問いを聞かれたら die にする（黙って否定を返すと、fail closed のテストが素通りするため）。
 */
export function decisionsTest(script: Script) {
  const calls: Array<{ purpose: string; input: unknown }> = [];
  const layer = Layer.succeed(
    Decisions,
    Decisions.of({
      ask: (question, input) =>
        Effect.gen(function* () {
          calls.push({ purpose: question.purpose, input });
          const answer = script[question.purpose];
          if (answer === undefined) return yield* Effect.die(new Error(`テストで答えを決めていない問い: ${question.purpose}`));
          const produced = answer(input);
          const answers = Effect.isEffect(produced) ? yield* produced : produced;
          const record: Record<string, AnswerRecord> = Object.fromEntries(
            Object.entries(answers).map(([key, value]) => [
              key,
              value._tag === "Unanswered"
                ? { _tag: "Unanswered", reason: value.reason }
                : { _tag: "Answered", probabilities: "probability" in value.value ? { true: value.value.probability } : { ...value.value.probabilities } },
            ]),
          );
          return {
            answers,
            record: { role: "Decisions", purpose: question.purpose, version: question.version, modelId: "test", answers: record, usage: { inputTokens: null, outputTokens: null } },
          } as DecisionResult<never>;
        }),
    }),
  );
  return { calls, layer };
}
