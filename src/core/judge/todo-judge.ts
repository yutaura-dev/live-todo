export type DecisionAnswer = { type: "predicate"; probability: number } | { type: "refusal" };

export type JudgeRequest = { input: string; question: string };

export interface DecisionsProvider {
  judgePredicate(request: JudgeRequest): Promise<DecisionAnswer>;
}

export interface StructuredClassifier {
  // 戻り値を "todo" | "not_todo" | "uncertain" に絞らない理由:
  // LLM の出力は型の約束を守る保証がなく、想定外の値を判定側で要確認に倒す必要があるため。
  classifyTodo(request: JudgeRequest): Promise<string>;
}

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
  decisions?: DecisionsProvider;
  structured: StructuredClassifier;
};

const STRUCTURED_VERDICTS: Record<string, TodoVerdict> = {
  todo: "todo",
  not_todo: "not_todo",
  uncertain: "needs_review",
};

export function createTodoJudge<TItem>(options: TodoJudgeOptions<TItem>): (item: TItem) => Promise<TodoJudgment> {
  const { rules, describe, question, thresholds, decisions, structured } = options;
  if (thresholds.todo < thresholds.review) {
    throw new Error("todo の閾値は要確認の閾値以上にしてください");
  }

  const verdictFromProbability = (probability: number): TodoVerdict => {
    if (probability >= thresholds.todo) return "todo";
    if (probability >= thresholds.review) return "needs_review";
    return "not_todo";
  };

  return async (item) => {
    if (rules.some((rule) => rule(item))) {
      return { verdict: "todo", method: "rule" };
    }

    const request = { input: describe(item), question };

    if (decisions) {
      const answer = await decisions.judgePredicate(request);
      if (answer.type !== "predicate" || !isProbability(answer.probability)) {
        return { verdict: "needs_review", method: "decisions" };
      }
      return { verdict: verdictFromProbability(answer.probability), method: "decisions", probability: answer.probability };
    }

    const answer = await structured.classifyTodo(request);
    return { verdict: STRUCTURED_VERDICTS[answer] ?? "needs_review", method: "structured" };
  };
}

function isProbability(value: number): boolean {
  return value >= 0 && value <= 1;
}
