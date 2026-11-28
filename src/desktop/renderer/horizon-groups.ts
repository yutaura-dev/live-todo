import type { PriorityLevel } from "../../llm/shared/vocabulary.js";
import type { BoardCard } from "../shared/api.js";

export const LEVELS: ReadonlyArray<PriorityLevel> = ["今すぐ", "今日中", "3 日以内", "10 日以内", "30 日以内", "それより先でよい"];

/** 見通しのまとまり。ラベル未定はユーザーに決めてもらうので今すぐの上、まだ一度も決めていないものは決まるまでいちばん下 */
export type GroupKey = "ラベル未定" | PriorityLevel | "未判定";
const ORDER: ReadonlyArray<GroupKey> = ["ラベル未定", ...LEVELS, "未判定"];
const ALWAYS_SHOWN: ReadonlySet<GroupKey> = new Set(["今すぐ", "今日中"]);

/** 決め直している間は前のラベルのまま並べる（prioritization.spec）ので、ラベルがあればその段に置く */
const keyOf = (card: BoardCard): GroupKey => (card.priority.status === "ラベル未定" ? "ラベル未定" : (card.priority.level ?? "未判定"));

export type HorizonGroup = { key: GroupKey; cards: BoardCard[] };

export function groupForHorizon(cards: ReadonlyArray<BoardCard>): HorizonGroup[] {
  const open = cards.filter((card) => card.status === "やること");
  return ORDER.map((key) => ({
    key,
    cards: open
      .filter((card) => keyOf(card) === key)
      // sort は安定なので、同じ重みどうしは届いた順のまま
      .toSorted((a, b) => Number(b.mark !== "なし") - Number(a.mark !== "なし") || Number(b.blocksOthers) - Number(a.blocksOthers)),
  })).filter((group) => group.cards.length > 0 || ALWAYS_SHOWN.has(group.key));
}

/** 遠い段ほど小さく見せる（近いものほど、開かずに手を付けられるだけの情報を出す） */
export const densityOf = (key: GroupKey): "row" | "line" => (key === "10 日以内" || key === "30 日以内" || key === "それより先でよい" ? "line" : "row");
