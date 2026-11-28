import type { Level, WireTask } from "./model.js";

/** 近い順。specs/priority.value.ts の Level と同じ並び */
export const HORIZONS: readonly Level[] = ["今すぐ", "今日中", "3 日以内", "10 日以内", "30 日以内", "それより先でよい"];

/**
 * 見通しのまとまり。ラベル未定はユーザーに決めてもらうので今すぐの上に置く（specs/prioritization.spec.ts）。
 * 未判定（まだ一度も決めていない）の置き場は spec にないので、決まるまでの仮の置き場としていちばん下に置く。
 */
export type GroupKey = "ラベル未定" | Level | "未判定";

const ORDER: readonly GroupKey[] = ["ラベル未定", ...HORIZONS, "未判定"];

/** 空でも見せるまとまり。「今日やることはない」と分かること自体が、朝いちばんに知りたい答えなので */
const ALWAYS_SHOWN: ReadonlySet<GroupKey> = new Set(["今すぐ", "今日中"]);

const isOpen = (task: WireTask) => task.status === "todo";

const groupOf = (task: WireTask): GroupKey | null => {
  if (task.priority === null) return null;
  if (task.priority.status === "ラベル未定" || task.priority.status === "未判定") return task.priority.status;
  return task.priority.level;
};

export type Attention = { kind: "新着" } | { kind: "更新" } | { kind: "なし" };

/**
 * 更新マークと新着（specs/task.spec.ts の判断表「更新マークと新着」）。保存せず、履歴と最後に見た時刻から導く。
 * 最後に見たあとの変化を項目ごとにまとめ、最後に変えたのがユーザー以外の項目が 1 つでもあれば更新マーク。
 * 件数は出さない理由: spec は印のあるなしだけを決めていて、何を数えるか（出来事か項目か）が決まっていないため。
 */
export function attentionOf(task: WireTask): Attention {
  if (task.lastSeenAt === null) return { kind: "新着" };
  const seenAt = task.lastSeenAt;
  const lastByField = new Map<string, string>();
  for (const activity of task.history.filter((entry) => entry.occurredAt > seenAt).toSorted((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    lastByField.set(activity.field, activity.by);
  }
  return [...lastByField.values()].some((by) => by !== "ユーザー") ? { kind: "更新" } : { kind: "なし" };
}

const needsLook = (task: WireTask) => attentionOf(task).kind !== "なし";

export type HorizonGroup = { level: GroupKey; tasks: WireTask[] };

export function groupByHorizon(tasks: ReadonlyArray<WireTask>): HorizonGroup[] {
  return ORDER.map((level) => ({
    level,
    tasks: tasks
      .filter((task) => isOpen(task) && groupOf(task) === level)
      // sort は安定なので、同じ重みどうしは渡された順のまま
      .toSorted((a, b) => Number(needsLook(b)) - Number(needsLook(a)) || Number(b.blocksOthers) - Number(a.blocksOthers)),
  })).filter((group) => group.tasks.length > 0 || ALWAYS_SHOWN.has(group.level));
}

export type Density = "full" | "row" | "line";

/** 遠いまとまりほど小さく見せる。近いものほど、開かずに手を付けられるだけの情報を出す */
export function densityOf(level: GroupKey): Density {
  if (level === "今すぐ") return "full";
  if (level === "ラベル未定" || level === "今日中" || level === "3 日以内") return "row";
  return "line";
}
