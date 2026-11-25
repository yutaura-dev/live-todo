import type { JudgeRequest, TodoVerdict } from "./todo-judge.js";

export type EvalLabel = "todo" | "not_todo";

export type EvalCase = { id: string; title: string; request: JudgeRequest; expected: EvalLabel };

/** judge-dataset.json の 1 件。expected はユーザーが付ける正解で、まだ付けていなければ null */
export type DatasetEntry = { id: string; title: string; request: JudgeRequest; expected: EvalLabel | null };

export type EvalPrediction = { verdict: TodoVerdict; probability?: number };

export type EvalReport = {
  total: number;
  /** 正解は todo なのに対象外と判定した件。いちばん避けたい失敗 */
  missedTodos: string[];
  /** 正解は対象外なのに todo と判定した件 */
  falseTodos: string[];
  needsReview: number;
  reviewRate: number;
  /** 要確認を除いた、判定できた件の正解率 */
  accuracyOnDecided: number;
  /** 確率の当たり具合（小さいほどよい）。確率がある判定方法だけ */
  brierScore?: number;
  /** これより低い確率だけを対象外にすれば、取りこぼしが出ない閾値。確率がある判定方法だけ */
  safeReviewThreshold?: number;
};

export function evaluate(cases: readonly EvalCase[], predictions: Readonly<Record<string, EvalPrediction>>): EvalReport {
  const missedTodos: string[] = [];
  const falseTodos: string[] = [];
  let needsReview = 0;
  let decided = 0;
  let correct = 0;
  const brier: number[] = [];
  const todoProbabilities: number[] = [];

  for (const evalCase of cases) {
    const prediction = predictions[evalCase.id];
    // 判定の結果がない（判定に失敗した）件は、判定できなかったものとして要確認に数える
    const verdict = prediction?.verdict ?? "needs_review";
    if (prediction?.probability !== undefined) {
      const truth = evalCase.expected === "todo" ? 1 : 0;
      brier.push((prediction.probability - truth) ** 2);
      if (evalCase.expected === "todo") todoProbabilities.push(prediction.probability);
    }

    if (verdict === "needs_review") {
      needsReview++;
      continue;
    }
    decided++;
    if (verdict === evalCase.expected) correct++;
    else if (evalCase.expected === "todo") missedTodos.push(evalCase.id);
    else falseTodos.push(evalCase.id);
  }

  return {
    total: cases.length,
    missedTodos,
    falseTodos,
    needsReview,
    reviewRate: cases.length === 0 ? 0 : needsReview / cases.length,
    accuracyOnDecided: decided === 0 ? 0 : correct / decided,
    ...(brier.length === 0 ? {} : { brierScore: brier.reduce((sum, value) => sum + value, 0) / brier.length }),
    ...(todoProbabilities.length === 0 ? {} : { safeReviewThreshold: Math.min(...todoProbabilities) }),
  };
}

/** 書き出し直したときに、すでに付けた正解を残す。並びは新しく書き出した順 */
export function mergeDataset(
  existing: readonly DatasetEntry[],
  exported: readonly Omit<DatasetEntry, "expected">[],
): DatasetEntry[] {
  const labels = new Map(existing.map((entry) => [entry.id, entry.expected]));
  return exported.map((entry) => ({ ...entry, expected: labels.get(entry.id) ?? null }));
}
