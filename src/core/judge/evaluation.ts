import type { JudgeRequest, TodoVerdict } from "./todo-judge.js";

export type EvalLabel = "todo" | "not_todo";

export type EvalCase = { id: string; title: string; request: JudgeRequest; expected: EvalLabel };

/** judge-dataset.json の 1 件。expected はユーザーが付ける正解で、まだ付けていなければ null */
export type DatasetEntry = { id: string; title: string; request: JudgeRequest; expected: EvalLabel | null };

export type EvalPrediction = { verdict: TodoVerdict; probability?: number };

export type CaseOutcome = "correct" | "missed" | "false_todo" | "review";

export type CaseResult = {
  id: string;
  title: string;
  expected: EvalLabel;
  verdict: TodoVerdict;
  probability?: number;
  /** missed: 正解は todo なのに対象外 / false_todo: 正解は対象外なのに todo / review: 要確認に回った */
  outcome: CaseOutcome;
};

export type EvalReport = {
  total: number;
  cases: CaseResult[];
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
  /**
   * todo と対象外を確率で区別できているか（1: 完全に区別できる / 0.5: 当てずっぽう）。
   * Brier score は区別できているかと確率の目盛りのずれをまとめて測るので、区別だけを別に見る。
   */
  auc?: number;
};

export function evaluate(cases: readonly EvalCase[], predictions: Readonly<Record<string, EvalPrediction>>): EvalReport {
  const missedTodos: string[] = [];
  const falseTodos: string[] = [];
  let needsReview = 0;
  let decided = 0;
  let correct = 0;
  const brier: number[] = [];
  const todoProbabilities: number[] = [];
  const notTodoProbabilities: number[] = [];
  const results: CaseResult[] = [];

  for (const evalCase of cases) {
    const prediction = predictions[evalCase.id];
    // 判定の結果がない（判定に失敗した）件は、判定できなかったものとして要確認に数える
    const verdict = prediction?.verdict ?? "needs_review";
    if (prediction?.probability !== undefined) {
      const truth = evalCase.expected === "todo" ? 1 : 0;
      brier.push((prediction.probability - truth) ** 2);
      if (evalCase.expected === "todo") todoProbabilities.push(prediction.probability);
      else notTodoProbabilities.push(prediction.probability);
    }

    let outcome: CaseOutcome;
    if (verdict === "needs_review") {
      needsReview++;
      outcome = "review";
    } else {
      decided++;
      if (verdict === evalCase.expected) {
        correct++;
        outcome = "correct";
      } else if (evalCase.expected === "todo") {
        missedTodos.push(evalCase.id);
        outcome = "missed";
      } else {
        falseTodos.push(evalCase.id);
        outcome = "false_todo";
      }
    }
    results.push({
      id: evalCase.id,
      title: evalCase.title,
      expected: evalCase.expected,
      verdict,
      ...(prediction?.probability === undefined ? {} : { probability: prediction.probability }),
      outcome,
    });
  }

  return {
    total: cases.length,
    cases: results,
    missedTodos,
    falseTodos,
    needsReview,
    reviewRate: cases.length === 0 ? 0 : needsReview / cases.length,
    accuracyOnDecided: decided === 0 ? 0 : correct / decided,
    ...(brier.length === 0 ? {} : { brierScore: brier.reduce((sum, value) => sum + value, 0) / brier.length }),
    ...(todoProbabilities.length === 0 ? {} : { safeReviewThreshold: Math.min(...todoProbabilities) }),
    ...(todoProbabilities.length === 0 || notTodoProbabilities.length === 0
      ? {}
      : { auc: aucOf(todoProbabilities, notTodoProbabilities) }),
  };
}

function aucOf(positives: readonly number[], negatives: readonly number[]): number {
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive > negative) wins += 1;
      else if (positive === negative) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

/**
 * 書き出し直したときに、すでに付けた正解を残す。並びは新しく書き出した順。
 * 書き出す側が使っているときの操作から読み取った正解（expected）を持っていれば、手で付けた正解がない件にだけ使う。
 */
export function mergeDataset(
  existing: readonly DatasetEntry[],
  exported: readonly (Omit<DatasetEntry, "expected"> & { expected?: EvalLabel | null })[],
): DatasetEntry[] {
  const labels = new Map(existing.map((entry) => [entry.id, entry.expected]));
  return exported.map((entry) => ({ ...entry, expected: labels.get(entry.id) ?? entry.expected ?? null }));
}

export type StatusChangeRecord = { kind: string; field?: string | null; after: unknown; actor: "sync" | "user" };

const LABEL_OF_STATUS: Readonly<Record<string, EvalLabel>> = {
  dismissed: "not_todo",
  todo: "todo",
  in_progress: "todo",
  done: "todo",
};

/**
 * 使っているときの操作から、判定の正解を読み取る。ユーザーが最後にステータスを変えた操作で決める。
 * 同期による変化（マージで自動的に done になったなど）や、何もしていない（放置）は正解として数えない。
 */
export function labelFromUserActions(changes: readonly StatusChangeRecord[]): EvalLabel | null {
  const userStatusChanges = changes.filter((change) => change.actor === "user" && change.kind === "field_changed" && change.field === "status");
  const last = userStatusChanges.at(-1);
  return typeof last?.after === "string" ? (LABEL_OF_STATUS[last.after] ?? null) : null;
}
