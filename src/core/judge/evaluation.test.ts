import { assert, describe, it } from "@effect/vitest";
import { type EvalCase, evaluate, mergeDataset } from "./evaluation.js";

const request = { input: "x", question: "q" };
const evalCase = (id: string, expected: "todo" | "not_todo"): EvalCase => ({ id, title: id, request, expected });

describe("evaluate", () => {
  it("取りこぼし（正解は todo なのに対象外）と余計な todo を数える", () => {
    const report = evaluate(
      [evalCase("a", "todo"), evalCase("b", "todo"), evalCase("c", "not_todo"), evalCase("d", "not_todo")],
      { a: { verdict: "todo" }, b: { verdict: "not_todo" }, c: { verdict: "todo" }, d: { verdict: "not_todo" } },
    );

    assert.deepInclude(report, { total: 4, missedTodos: ["b"], falseTodos: ["c"], needsReview: 0, accuracyOnDecided: 0.5 });
  });

  it("要確認に回ったものは、判定できた件の正解率に含めず、割合を別に数える", () => {
    const report = evaluate([evalCase("a", "todo"), evalCase("b", "not_todo")], {
      a: { verdict: "needs_review" },
      b: { verdict: "not_todo" },
    });

    assert.deepInclude(report, { needsReview: 1, reviewRate: 0.5, accuracyOnDecided: 1 });
  });

  it("確率があれば Brier score と、取りこぼしを出さない閾値（正解が todo の件のいちばん低い確率）を出す", () => {
    const report = evaluate([evalCase("a", "todo"), evalCase("b", "todo"), evalCase("c", "not_todo")], {
      a: { verdict: "todo", probability: 0.9 },
      b: { verdict: "needs_review", probability: 0.3 },
      c: { verdict: "not_todo", probability: 0.1 },
    });

    assert.closeTo(report.brierScore ?? -1, (0.01 + 0.49 + 0.01) / 3, 1e-9);
    assert.strictEqual(report.safeReviewThreshold, 0.3);
  });

  it("判定の結果がない件は、判定できなかったものとして要確認に数える", () => {
    const report = evaluate([evalCase("a", "todo")], {});

    assert.deepInclude(report, { needsReview: 1, missedTodos: [] });
  });
});

describe("1 件ごとの結果", () => {
  it("正解・判定・確率を 1 件ごとに並べ、外れた件に印を付ける", () => {
    const report = evaluate([evalCase("a", "todo"), evalCase("b", "not_todo")], {
      a: { verdict: "not_todo", probability: 0.02 },
      b: { verdict: "needs_review" },
    });

    assert.deepStrictEqual(report.cases, [
      { id: "a", title: "a", expected: "todo", verdict: "not_todo", probability: 0.02, outcome: "missed" },
      { id: "b", title: "b", expected: "not_todo", verdict: "needs_review", outcome: "review" },
    ]);
  });
});

describe("mergeDataset", () => {
  it("書き出し直しても、すでに付けた正解は残し、新しい件は正解なしで足す", () => {
    const merged = mergeDataset(
      [{ id: "a", title: "A", request, expected: "todo" }],
      [
        { id: "a", title: "A（更新）", request: { input: "y", question: "q" } },
        { id: "b", title: "B", request },
      ],
    );

    assert.deepStrictEqual(merged, [
      { id: "a", title: "A（更新）", request: { input: "y", question: "q" }, expected: "todo" },
      { id: "b", title: "B", request, expected: null },
    ]);
  });
});
