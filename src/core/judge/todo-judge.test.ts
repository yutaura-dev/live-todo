import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import {
  type DecisionAnswer,
  DecisionsProvider,
  InvalidThresholdsError,
  JudgeRequestError,
  makeTodoJudge,
  StructuredClassifier,
} from "./todo-judge.js";

type Item = { text: string; reviewRequested?: boolean };

const QUESTION = "このメッセージは自分が対応すべきタスクか？";
const thresholds = { todo: 0.8, review: 0.4 };

const options = {
  rules: [(item: Item) => item.reviewRequested === true],
  describe: (item: Item) => Effect.succeed({ input: item.text }),
  question: QUESTION,
  thresholds,
};

const decisionsReturning = (answer: DecisionAnswer) =>
  DecisionsProvider.of({ judgePredicate: vi.fn(() => Effect.succeed(answer)) });

const structuredReturning = (answer: unknown) =>
  StructuredClassifier.of({ classifyTodo: vi.fn(() => Effect.succeed(answer)) });

const judgeWith = (
  item: Item,
  services: { decisions?: DecisionsProvider["Service"]; structured: StructuredClassifier["Service"] },
) =>
  Effect.gen(function* () {
    const judge = yield* makeTodoJudge(options);
    return yield* judge(item);
  }).pipe(
    Effect.provideService(StructuredClassifier, services.structured),
    services.decisions ? Effect.provideService(DecisionsProvider, services.decisions) : (self) => self,
  );

describe("規則による判定", () => {
  it.effect("規則に一致した項目は LLM を呼ばずに todo と判定する", () =>
    Effect.gen(function* () {
      const decisions = decisionsReturning({ type: "predicate", probability: 0 });
      const structured = structuredReturning("not_todo");

      const result = yield* judgeWith({ text: "PR #1", reviewRequested: true }, { decisions, structured });

      assert.deepStrictEqual(result, { verdict: "todo", method: "rule" });
      expect(decisions.judgePredicate).not.toHaveBeenCalled();
      expect(structured.classifyTodo).not.toHaveBeenCalled();
    }));
});

describe("Decisions provider による判定", () => {
  it.effect.each([
    [0.95, "todo"],
    [0.8, "todo"],
    [0.79, "needs_review"],
    [0.4, "needs_review"],
    [0.39, "not_todo"],
  ] as const)("確率 %s は %s と判定する", ([probability, verdict]) =>
    Effect.gen(function* () {
      const result = yield* judgeWith(
        { text: "確認お願いします" },
        { decisions: decisionsReturning({ type: "predicate", probability }), structured: structuredReturning("todo") },
      );

      assert.deepStrictEqual(result, { verdict, method: "decisions", probability });
    }));

  it.effect("評価対象の内容を input に、質問を question に渡す", () =>
    Effect.gen(function* () {
      const decisions = decisionsReturning({ type: "predicate", probability: 0.9 });

      yield* judgeWith({ text: "明日までにレビューしてください" }, { decisions, structured: structuredReturning("todo") });

      expect(decisions.judgePredicate).toHaveBeenCalledWith({ input: "明日までにレビューしてください", question: QUESTION });
    }));

  it.effect("refusal が返ったら要確認にする", () =>
    Effect.gen(function* () {
      const result = yield* judgeWith(
        { text: "..." },
        { decisions: decisionsReturning({ type: "refusal" }), structured: structuredReturning("todo") },
      );

      assert.deepStrictEqual(result, { verdict: "needs_review", method: "decisions" });
    }));

  it.effect.each([Number.NaN, -0.1, 1.1])("0 から 1 の範囲外の確率 %s が返ったら要確認にする", (probability) =>
    Effect.gen(function* () {
      const result = yield* judgeWith(
        { text: "..." },
        { decisions: decisionsReturning({ type: "predicate", probability }), structured: structuredReturning("todo") },
      );

      assert.deepStrictEqual(result, { verdict: "needs_review", method: "decisions" });
    }));

  it.effect("Decisions provider が使えるときは structured output を呼ばない", () =>
    Effect.gen(function* () {
      const structured = structuredReturning("todo");

      yield* judgeWith({ text: "..." }, { decisions: decisionsReturning({ type: "predicate", probability: 0.1 }), structured });

      expect(structured.classifyTodo).not.toHaveBeenCalled();
    }));

  it.effect("通信エラーは要確認にせず呼び出し元に伝える", () =>
    Effect.gen(function* () {
      const decisions = DecisionsProvider.of({
        judgePredicate: () => Effect.fail(new JudgeRequestError({ message: "network" })),
      });

      const error = yield* Effect.flip(judgeWith({ text: "..." }, { decisions, structured: structuredReturning("todo") }));

      assert.instanceOf(error, JudgeRequestError);
      assert.strictEqual(error.message, "network");
    }));
});

describe("structured output による判定（Decisions provider が使えない場合）", () => {
  it.effect.each([
    ["todo", "todo"],
    ["not_todo", "not_todo"],
    ["uncertain", "needs_review"],
  ] as const)("%s が返ったら %s と判定する", ([answer, verdict]) =>
    Effect.gen(function* () {
      const result = yield* judgeWith({ text: "..." }, { structured: structuredReturning(answer) });

      assert.deepStrictEqual(result, { verdict, method: "structured" });
    }));

  it.effect("想定外の値が返ったら要確認にする", () =>
    Effect.gen(function* () {
      const result = yield* judgeWith({ text: "..." }, { structured: structuredReturning("maybe") });

      assert.deepStrictEqual(result, { verdict: "needs_review", method: "structured" });
    }));

  it.effect("評価対象の内容を渡す", () =>
    Effect.gen(function* () {
      const structured = structuredReturning("todo");

      yield* judgeWith({ text: "請求書を送ってください" }, { structured });

      expect(structured.classifyTodo).toHaveBeenCalledWith({ input: "請求書を送ってください", question: QUESTION });
    }));
});

describe("説明文の作り方", () => {
  it.effect("規則で決まった項目では、説明文を作らない（説明文の材料を取りに行かない）", () =>
    Effect.gen(function* () {
      let described = 0;
      const judge = yield* makeTodoJudge({
        ...options,
        describe: (item: Item) => Effect.sync(() => {
          described++;
          return { input: item.text };
        }),
      });

      yield* judge({ text: "PR", reviewRequested: true }).pipe(Effect.provideService(StructuredClassifier, structuredReturning("todo")));

      assert.strictEqual(described, 0);
    }));
});

describe("信頼できる情報", () => {
  it.effect("説明文が context を返したら、評価対象とは別に classifier へ渡す", () =>
    Effect.gen(function* () {
      const structured = structuredReturning("todo");
      const judge = yield* makeTodoJudge({ ...options, describe: (item: Item) => Effect.succeed({ input: item.text, context: "自分: @me" }) });

      yield* judge({ text: "本文" }).pipe(Effect.provideService(StructuredClassifier, structured));

      expect(structured.classifyTodo).toHaveBeenCalledWith({ input: "本文", question: QUESTION, context: "自分: @me" });
    }));
});

describe("閾値の検証", () => {
  it.effect("todo の閾値が要確認の閾値より小さいとエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeTodoJudge({ ...options, thresholds: { todo: 0.3, review: 0.5 } }));

      assert.instanceOf(error, InvalidThresholdsError);
    }));
});
