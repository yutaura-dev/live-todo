import { Context, Effect, Option, Schema } from "effect";

export class JudgeRequestError extends Schema.TaggedError<JudgeRequestError>()("JudgeRequestError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidThresholdsError extends Schema.TaggedError<InvalidThresholdsError>()("InvalidThresholdsError", {
  todo: Schema.Number,
  review: Schema.Number,
}) {}

export type JudgeRequest = { input: string; question: string };

export type DecisionAnswer = { type: "predicate"; probability: number } | { type: "refusal" };

export class DecisionsProvider extends Context.Service<DecisionsProvider, {
  judgePredicate(request: JudgeRequest): Effect.Effect<DecisionAnswer, JudgeRequestError>;
}>()("live-todo/core/judge/DecisionsProvider") {}

export class StructuredClassifier extends Context.Service<StructuredClassifier, {
  // 戻り値を unknown にしている理由:
  // LLM の出力は型の約束を守る保証がなく、判定側で Schema によって検証して想定外の値を要確認に倒すため。
  classifyTodo(request: JudgeRequest): Effect.Effect<unknown, JudgeRequestError>;
}>()("live-todo/core/judge/StructuredClassifier") {}

export type TodoVerdict = "todo" | "needs_review" | "not_todo";

export type TodoJudgment =
  | { verdict: TodoVerdict; method: "rule" | "structured" }
  | { verdict: TodoVerdict; method: "decisions"; probability?: number };

export type TodoJudgeThresholds = { todo: number; review: number };

export type TodoJudgeOptions<TItem> = {
  rules: readonly ((item: TItem) => boolean)[];
  describe: (item: TItem) => string;
  question: string;
  thresholds: TodoJudgeThresholds;
};

export type TodoJudge<TItem> = (item: TItem) => Effect.Effect<TodoJudgment, JudgeRequestError, StructuredClassifier>;

const isProbability = Schema.is(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })));

const StructuredAnswer = Schema.Literals(["todo", "not_todo", "uncertain"]);
const decodeStructuredAnswer = Schema.decodeUnknownOption(StructuredAnswer);

const STRUCTURED_VERDICTS = {
  todo: "todo",
  not_todo: "not_todo",
  uncertain: "needs_review",
} as const satisfies Record<typeof StructuredAnswer.Type, TodoVerdict>;

export const makeTodoJudge = Effect.fnUntraced(function* <TItem>(
  options: TodoJudgeOptions<TItem>,
): Effect.fn.Return<TodoJudge<TItem>, InvalidThresholdsError> {
  const { rules, describe, question, thresholds } = options;
  if (thresholds.todo < thresholds.review) {
    return yield* new InvalidThresholdsError(thresholds);
  }

  const verdictFromProbability = (probability: number): TodoVerdict => {
    if (probability >= thresholds.todo) return "todo";
    if (probability >= thresholds.review) return "needs_review";
    return "not_todo";
  };

  const judge: TodoJudge<TItem> = (item) =>
    Effect.gen(function* () {
      if (rules.some((rule) => rule(item))) {
        return { verdict: "todo", method: "rule" } as const;
      }

      const request = { input: describe(item), question };

      // Decisions provider を必須の依存にしない理由:
      // 使えるかどうかは LLM Profile の capability で決まり、提供されていなければ fallback に落とすため（ADR-0003）。
      const decisions = yield* Effect.serviceOption(DecisionsProvider);
      if (Option.isSome(decisions)) {
        const answer = yield* decisions.value.judgePredicate(request);
        if (answer.type !== "predicate" || !isProbability(answer.probability)) {
          return { verdict: "needs_review", method: "decisions" } as const;
        }
        return {
          verdict: verdictFromProbability(answer.probability),
          method: "decisions",
          probability: answer.probability,
        } as const;
      }

      const structured = yield* StructuredClassifier;
      const answer = decodeStructuredAnswer(yield* structured.classifyTodo(request));
      return {
        verdict: Option.match(answer, { onNone: () => "needs_review", onSome: (value) => STRUCTURED_VERDICTS[value] }),
        method: "structured",
      } as const;
    });

  return judge;
});
