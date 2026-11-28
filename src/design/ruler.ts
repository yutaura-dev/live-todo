import type { GroupKey } from "../wireframes/horizon.js";

export type Ruler = {
  /** 0 がいちばん近い。目盛りの文字と線は、深いほど小さく淡くなる */
  depth: number;
  label: string;
  /** decide: 自分が決めないと進まない / pending: アプリが決めている途中 / normal: ふつうの段 */
  tone: "decide" | "pending" | "normal";
};

const LEVEL_DEPTHS: Record<Exclude<GroupKey, "ラベル未定" | "未判定">, number> = {
  今すぐ: 0,
  今日中: 1,
  "3 日以内": 2,
  "10 日以内": 3,
  "30 日以内": 4,
  それより先でよい: 5,
};

/** 見通しの左端に引く「時の物差し」の目盛り。まとまり（horizon.ts の GroupKey）ごとに、近さと書き方を決める */
export function rulerOf(group: GroupKey): Ruler {
  if (group === "ラベル未定") return { depth: 0, label: "未定", tone: "decide" };
  if (group === "未判定") return { depth: 5, label: "判定中", tone: "pending" };
  return { depth: LEVEL_DEPTHS[group], label: group === "それより先でよい" ? "それより先" : group, tone: "normal" };
}
