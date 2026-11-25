import { Context, Effect, Option, Schema } from "effect";

export class JudgeRequestError extends Schema.TaggedError<JudgeRequestError>()("JudgeRequestError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidThresholdsError extends Schema.TaggedError<InvalidThresholdsError>()("InvalidThresholdsError", {
  todo: Schema.Number,
  review: Schema.Number,
}) {}

export type JudgeRequest = {
  /** 評価対象。外部から来た文字列を含むので、データとして扱う */
  input: string;
  question: string;
  /** live-todo が書いた信頼できる情報（自分のアカウント名・通知の理由など）。評価対象とは分けて渡す */
  context?: string;
};

export type JudgeInput = { input: string; context?: string };

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

/** LLM や Decisions で判定したときは、渡した入力（request）を含める。同じ入力で判定し直して比べられるようにするため */
export type TodoJudgment =
  | { verdict: TodoVerdict; method: "rule" }
  | { verdict: TodoVerdict; method: "structured"; reason?: string; request: JudgeRequest }
  | { verdict: TodoVerdict; method: "decisions"; probability?: number; request: JudgeRequest };

export type TodoJudgeThresholds = { todo: number; review: number };

/** 初期値。運用しながら調整する（docs/architecture.md の「判定の閾値」） */
export const DEFAULT_TODO_THRESHOLDS: TodoJudgeThresholds = { todo: 0.8, review: 0.4 };

export type TodoJudgeOptions<TItem> = {
  rules: readonly ((item: TItem) => boolean)[];
  /** LLM に渡す説明文。規則で決まった項目では呼ばない（説明文の材料を取りに行くのを LLM に回すときに限る） */
  describe: (item: TItem) => Effect.Effect<JudgeInput>;
  question: string;
  thresholds: TodoJudgeThresholds;
};

export type TodoJudge<TItem> = (item: TItem) => Effect.Effect<TodoJudgment, JudgeRequestError, StructuredClassifier>;

const isProbability = Schema.is(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })));

const StructuredVerdict = Schema.Literals(["todo", "not_todo", "uncertain"]);
// 理由を返さない classifier（ConservativeClassifier など）もあるので、verdict だけの答えも受け付ける
const StructuredAnswer = Schema.Union([
  StructuredVerdict,
  Schema.Struct({ verdict: StructuredVerdict, reason: Schema.optional(Schema.String) }),
]);
const decodeStructuredAnswer = Schema.decodeUnknownOption(StructuredAnswer);

const STRUCTURED_VERDICTS = {
  todo: "todo",
  not_todo: "not_todo",
  uncertain: "needs_review",
} as const satisfies Record<typeof StructuredVerdict.Type, TodoVerdict>;

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

      const described = yield* describe(item);
      const request: JudgeRequest = {
        input: described.input,
        question,
        ...(described.context === undefined ? {} : { context: described.context }),
      };

      // Decisions provider を必須の依存にしない理由:
      // 使えるかどうかは LLM Profile の capability で決まり、提供されていなければ fallback に落とすため（ADR-0003）。
      const decisions = yield* Effect.serviceOption(DecisionsProvider);
      if (Option.isSome(decisions)) {
        const answer = yield* decisions.value.judgePredicate(request);
        if (answer.type !== "predicate" || !isProbability(answer.probability)) {
          return { verdict: "needs_review", method: "decisions", request } as const;
        }
        return {
          verdict: verdictFromProbability(answer.probability),
          method: "decisions",
          probability: answer.probability,
          request,
        } as const;
      }

      const structured = yield* StructuredClassifier;
      const answer = decodeStructuredAnswer(yield* structured.classifyTodo(request));
      if (Option.isNone(answer)) return { verdict: "needs_review", method: "structured", request } as const;
      const { verdict, reason } = typeof answer.value === "string" ? { verdict: answer.value, reason: undefined } : answer.value;
      return {
        verdict: STRUCTURED_VERDICTS[verdict],
        method: "structured",
        request,
        ...(reason === undefined ? {} : { reason }),
      } as const;
    });

  return judge;
});
