import type { Decision } from "effect/ai";
import type { Answer } from "../shared/answer.js";

/**
 * 分類・段階の答えから、いちばん確率の高いラベルを閾値以上のときだけ取り出す（届かない・答えなかったら null）。
 * provider が返す label を使わない理由: label は確率がいちばん高いとは限らない（effect/ai の ClassifyAnswer）ため、確率で決め直す。
 */
export function topLabelAtLeast<L extends string>(
  answer: Answer<Decision.ClassifyAnswer<L> | Decision.RateAnswer<L>>,
  threshold: number,
): { label: L; probability: number } | null {
  if (answer._tag === "Unanswered") return null;
  const entries = Object.entries(answer.value.probabilities) as Array<[L, number]>;
  const top = entries.reduce<[L, number] | null>((best, entry) => (best === null || entry[1] > best[1] ? entry : best), null);
  return top !== null && top[1] >= threshold ? { label: top[0], probability: top[1] } : null;
}
