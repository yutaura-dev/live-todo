import { Context, Effect, Layer, Result } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import { type Answer, answered, fromAiError, type UnansweredReason, unanswered } from "../shared/answer.js";
import { AiUnreachableError } from "../shared/errors.js";
import type { AnswerRecord, CallRecord } from "../shared/record.js";
import type { DecisionQuestion, QuestionInput, TextDecision } from "./question.js";

export type DecisionAnswers<D extends Record<string, TextDecision>> = { readonly [K in keyof D]: Answer<Decision.Answer<D[K]>> };

export interface DecisionResult<D extends Record<string, TextDecision>> {
  readonly answers: DecisionAnswers<D>;
  readonly record: CallRecord;
}

/** AI 設定の Decisions（確率付きの判定）。理由は返さない。答えなかった問いは Answer の値で、届かなかったときは AiUnreachableError で返す */
export class Decisions extends Context.Service<
  Decisions,
  {
    ask<S extends QuestionInput, D extends Record<string, TextDecision>>(question: DecisionQuestion<S, D>, input: S["Type"]): Effect.Effect<DecisionResult<D>, AiUnreachableError>;
  }
>()("live-todo/llm/decision/Decisions") {}

const reasonOf = (reason: Decision.Unanswered["reason"]): UnansweredReason =>
  reason === "Missing" ? "Missing" : reason === "Refused" ? "Refused" : "Invalid";

function probabilitiesOf(answer: Decision.Answer<TextDecision>): Record<string, number> {
  if ("probability" in answer) return { true: answer.probability };
  if ("probabilities" in answer) return { ...answer.probabilities };
  return {};
}

const recordOf = (answer: Answer<Decision.Answer<TextDecision>>): AnswerRecord =>
  answer._tag === "Answered" ? { _tag: "Answered", probabilities: probabilitiesOf(answer.value) } : { _tag: "Unanswered", reason: answer.reason };

function resultOf<D extends Record<string, TextDecision>>(
  question: { readonly purpose: string; readonly version: number },
  keys: ReadonlyArray<string>,
  answerOf: (key: string) => Answer<Decision.Answer<TextDecision>>,
  meta: { modelId: string | null; inputTokens: number | null; outputTokens: number | null },
): DecisionResult<D> {
  const answers = Object.fromEntries(keys.map((key) => [key, answerOf(key)]));
  return {
    answers: answers as DecisionAnswers<D>,
    record: {
      role: "Decisions",
      purpose: question.purpose,
      version: question.version,
      modelId: meta.modelId,
      answers: Object.fromEntries(keys.map((key) => [key, recordOf(answers[key]!)])),
      usage: { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens },
    },
  };
}

/** effect/ai の DecisionModel で Decisions を提供する。provider（OpenAI Decisions・Microsoft-Decision など）は DecisionModel を提供する側で決める */
export const decisionsFromModel = Layer.effect(
  Decisions,
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel;
    const ask = <S extends QuestionInput, D extends Record<string, TextDecision>>(
      question: DecisionQuestion<S, D>,
      input: S["Type"],
    ): Effect.Effect<DecisionResult<D>, AiUnreachableError> => {
      const decisions = question.decisions(input);
      const keys = Object.keys(decisions);
      // decide でなく decideSettled を使う理由: 1 つの問いを断られても、同じリクエストのほかの問いの答えを捨てないため
      const settled = model.decideSettled(Decision.make({ input: question.input, decisions }), { input }).pipe(
        Effect.map((response) =>
          resultOf<D>(
            question,
            keys,
            (key) => {
              const outcome = response.outcomes[key]!;
              return Result.isSuccess(outcome) ? answered(outcome.success) : unanswered(reasonOf(outcome.failure.reason));
            },
            { modelId: response.modelId ?? null, inputTokens: response.usage.inputTokens ?? null, outputTokens: response.usage.outputTokens ?? null },
          ),
        ),
        Effect.catchTag("AiError", (error) => {
          const classified = fromAiError(error);
          if (classified._tag === "Unreachable") {
            return Effect.fail(new AiUnreachableError({ role: "Decisions", purpose: question.purpose, reason: classified.reason }));
          }
          return Effect.succeed(resultOf<D>(question, keys, () => classified, { modelId: null, inputTokens: null, outputTokens: null }));
        }),
      );
      // QuestionInput で EncodingServices を never に絞っているが、S["EncodingServices"] のままでは型が畳まれないため
      return settled as Effect.Effect<DecisionResult<D>, AiUnreachableError>;
    };
    return Decisions.of({ ask });
  }),
);
