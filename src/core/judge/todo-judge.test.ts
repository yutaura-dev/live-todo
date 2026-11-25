import { describe, expect, it, vi } from "vitest";
import { createTodoJudge, type DecisionsProvider, type StructuredClassifier } from "./todo-judge.js";

type Item = { text: string; reviewRequested?: boolean };

const QUESTION = "このメッセージは自分が対応すべきタスクか？";
const thresholds = { todo: 0.8, review: 0.4 };

const decisionsReturning = (answer: Awaited<ReturnType<DecisionsProvider["judgePredicate"]>>): DecisionsProvider => ({
  judgePredicate: vi.fn().mockResolvedValue(answer),
});

const structuredReturning = (answer: string): StructuredClassifier => ({
  classifyTodo: vi.fn().mockResolvedValue(answer),
});

const baseOptions = {
  rules: [(item: Item) => item.reviewRequested === true],
  describe: (item: Item) => item.text,
  question: QUESTION,
  thresholds,
};

describe("規則による判定", () => {
  it("規則に一致した項目は LLM を呼ばずに todo と判定する", async () => {
    const decisions = decisionsReturning({ type: "predicate", probability: 0 });
    const structured = structuredReturning("not_todo");
    const judge = createTodoJudge({ ...baseOptions, decisions, structured });

    const result = await judge({ text: "PR #1", reviewRequested: true });

    expect(result).toEqual({ verdict: "todo", method: "rule" });
    expect(decisions.judgePredicate).not.toHaveBeenCalled();
    expect(structured.classifyTodo).not.toHaveBeenCalled();
  });
});

describe("Decisions provider による判定", () => {
  it.each([
    [0.95, "todo"],
    [0.8, "todo"],
    [0.79, "needs_review"],
    [0.4, "needs_review"],
    [0.39, "not_todo"],
  ] as const)("確率 %s は %s と判定する", async (probability, verdict) => {
    const judge = createTodoJudge({
      ...baseOptions,
      decisions: decisionsReturning({ type: "predicate", probability }),
      structured: structuredReturning("todo"),
    });

    const result = await judge({ text: "確認お願いします" });

    expect(result).toEqual({ verdict, method: "decisions", probability });
  });

  it("評価対象の内容を input に、質問を question に渡す", async () => {
    const decisions = decisionsReturning({ type: "predicate", probability: 0.9 });
    const judge = createTodoJudge({ ...baseOptions, decisions, structured: structuredReturning("todo") });

    await judge({ text: "明日までにレビューしてください" });

    expect(decisions.judgePredicate).toHaveBeenCalledWith({
      input: "明日までにレビューしてください",
      question: QUESTION,
    });
  });

  it("refusal が返ったら要確認にする", async () => {
    const judge = createTodoJudge({
      ...baseOptions,
      decisions: decisionsReturning({ type: "refusal" }),
      structured: structuredReturning("todo"),
    });

    const result = await judge({ text: "..." });

    expect(result).toEqual({ verdict: "needs_review", method: "decisions" });
  });

  it.each([Number.NaN, -0.1, 1.1])("0 から 1 の範囲外の確率 %s が返ったら要確認にする", async (probability) => {
    const judge = createTodoJudge({
      ...baseOptions,
      decisions: decisionsReturning({ type: "predicate", probability }),
      structured: structuredReturning("todo"),
    });

    const result = await judge({ text: "..." });

    expect(result).toEqual({ verdict: "needs_review", method: "decisions" });
  });

  it("Decisions provider が使えるときは structured output を呼ばない", async () => {
    const structured = structuredReturning("todo");
    const judge = createTodoJudge({
      ...baseOptions,
      decisions: decisionsReturning({ type: "predicate", probability: 0.1 }),
      structured,
    });

    await judge({ text: "..." });

    expect(structured.classifyTodo).not.toHaveBeenCalled();
  });

  it("通信エラーは要確認にせず呼び出し元に伝える", async () => {
    const decisions: DecisionsProvider = { judgePredicate: vi.fn().mockRejectedValue(new Error("network")) };
    const judge = createTodoJudge({ ...baseOptions, decisions, structured: structuredReturning("todo") });

    await expect(judge({ text: "..." })).rejects.toThrow("network");
  });
});

describe("structured output による判定（Decisions provider が使えない場合）", () => {
  it.each([
    ["todo", "todo"],
    ["not_todo", "not_todo"],
    ["uncertain", "needs_review"],
  ] as const)("%s が返ったら %s と判定する", async (answer, verdict) => {
    const judge = createTodoJudge({ ...baseOptions, structured: structuredReturning(answer) });

    const result = await judge({ text: "..." });

    expect(result).toEqual({ verdict, method: "structured" });
  });

  it("想定外の値が返ったら要確認にする", async () => {
    const judge = createTodoJudge({ ...baseOptions, structured: structuredReturning("maybe") });

    const result = await judge({ text: "..." });

    expect(result).toEqual({ verdict: "needs_review", method: "structured" });
  });

  it("評価対象の内容を渡す", async () => {
    const structured = structuredReturning("todo");
    const judge = createTodoJudge({ ...baseOptions, structured });

    await judge({ text: "請求書を送ってください" });

    expect(structured.classifyTodo).toHaveBeenCalledWith({ input: "請求書を送ってください", question: QUESTION });
  });
});

describe("閾値の検証", () => {
  it("todo の閾値が要確認の閾値より小さいとエラーにする", () => {
    expect(() =>
      createTodoJudge({ ...baseOptions, thresholds: { todo: 0.3, review: 0.5 }, structured: structuredReturning("todo") }),
    ).toThrow("todo の閾値は要確認の閾値以上にしてください");
  });
});
