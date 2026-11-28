import type { Answer } from "./answer.js";

/** 判断表（spec の decisions）が読む確率の区分 */
export type Band = "高い" | "中間" | "低い";

/**
 * 問いごとに決め打ちにする閾値（AI 設定には持たない。ADR-0022）。初めの値は仮で、ベンチマークで決める。
 * 中間（highAtLeast 未満・lowBelow 以上）は、黙って決めずにユーザーに見せる幅。
 */
export type Thresholds = { readonly highAtLeast: number; readonly lowBelow: number };

export function makeThresholds(thresholds: Thresholds): Thresholds {
  const inUnit = (n: number) => n >= 0 && n <= 1;
  if (!inUnit(thresholds.highAtLeast) || !inUnit(thresholds.lowBelow) || thresholds.lowBelow > thresholds.highAtLeast) {
    throw new Error(`閾値は 0〜1 で、lowBelow ≦ highAtLeast にする（${thresholds.lowBelow} / ${thresholds.highAtLeast}）`);
  }
  return thresholds;
}

export const bandOf = (probability: number, thresholds: Thresholds): Band =>
  probability >= thresholds.highAtLeast ? "高い" : probability < thresholds.lowBelow ? "低い" : "中間";

export const bandOfAnswer = (answer: Answer<{ readonly probability: number }>, thresholds: Thresholds): Band | "判断できなかった" =>
  answer._tag === "Unanswered" ? "判断できなかった" : bandOf(answer.value.probability, thresholds);
