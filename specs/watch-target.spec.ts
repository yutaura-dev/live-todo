import { ensure } from "@yutaura/live-spec";
import type { Subject } from "./condition.value.ts";

/**
 * Watcher が見張る対象 1 つ（ADR-0008・0009）。同じ対象は 1 つだけ持つ（対象で探し、あれば理由を足す）。
 * 見張る理由は 2 つある。
 * - 自分の対象: 自分が関わる開いている対象（自分の PR など）。一覧で取って見張り、困った状態（conflict・CI の失敗など）を事実の行として Source Item に届ける
 * - 待っている: 待つ条件の Action Item が指す対象（他人の PR・deploy の PR を探す検索・ワークフローの実行など）。待っている Action Item がある間だけ見張る
 * 対象の取り方・確かめ方・何が変わったか（fingerprint）は、Source ごとの provider が実装する。ここでは、いつ確かめるかと、見張る理由だけを決める。
 * 確かめても変わらなければ確認の間隔を倍に延ばし（最初 5 分、上限 1 日）、変わったら最初に戻す。確かめない間は、前に確かめた結果を引き継ぐ。
 */
export type WatchTarget = {
  /** 見張っているか。理由が 1 つもなくなったら、最後に確かめてから見張らなくなる */
  watching: Watching;
  /** 自分の対象として、一覧にあるか */
  mine: boolean;
  /** 待っている Action Item があるか（どの Action Item かは waitingItemIds に持つ） */
  waiters: Waiters;
  /** 次に確かめるまでの間隔 */
  interval: Interval;
  /** 確かめる時刻が来ているか */
  due: Due;
  /** 見張る対象（1 つの項目・検索・ワークフローの実行も、provider が決めた識別子で表す） */
  subject: Subject;
  /** 待っている Action Item */
  waitingItemIds: string[];
  /** 一覧で分かる、対象の更新を表す値（GitHub なら PR の updated_at）。変わったら予定より前でも確かめる */
  revision: string | null;
  /** 判定に効く値だけを並べたもの（provider が決める。GitHub の PR なら head の commit・mergeable・check・レビュー）。変わらなければ間隔を延ばす */
  fingerprint: string | null;
  /** 次に確かめる時刻。間隔から決め、時間の条件が成り立つかもしれない時刻より遅らせない */
  nextCheckAt: string;
};

export const Watching = {
  /** 見張っている */
  on: "見張っている",
  /** 見張らない（自分の対象でも、待っている Action Item もない） */
  off: "やめた",
} as const;
export type Watching = (typeof Watching)[keyof typeof Watching];

export const Waiters = {
  /** 待っている Action Item はない */
  none: "なし",
  /** 待っている Action Item がある */
  some: "あり",
} as const;
export type Waiters = (typeof Waiters)[keyof typeof Waiters];

export const Interval = {
  /** 最初の間隔（GitHub では 5 分） */
  initial: "最初",
  /** 確かめても変わらないので、倍に延ばしている（上限に届くまで続く） */
  extending: "延ばしている",
  /** 上限（1 日） */
  max: "上限",
} as const;
export type Interval = (typeof Interval)[keyof typeof Interval];

export const Due = {
  /** 次に確かめる時刻を待っている */
  waiting: "まだ",
  /** 確かめる時刻が来た（一覧の更新を表す値が変わった・一覧から外れて最後に確かめる、も含む） */
  now: "確かめる時刻",
} as const;
export type Due = (typeof Due)[keyof typeof Due];

/** 確かめて分かった、対象の変化（間隔を決めるためのもの。条件が成り立ったかの判定は、届け先が受け取る） */
type Change = "変わらない" | "変わらない（上限に届く）" | "変わった" | "分からない条件がある";
type Actor = { kind: "sync" } | { kind: "clock" };

export const actors: Record<string, Actor> = {
  同期: { kind: "sync" },
  時の流れ: { kind: "clock" },
};

const START = { watching: "見張っている", interval: "最初", due: "確かめる時刻" } as const;
const hasReason = (t: WatchTarget) => t.mine || t.waiters === "あり";

/** 見張りを始める（自分の対象が一覧に初めて現れた・待つ条件の Action Item ができた） */
export function initial(actor: Actor, reason: "自分の対象" | "待っている"): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  return {
    ...START,
    mine: reason === "自分の対象",
    waiters: reason === "待っている" ? "あり" : "なし",
    subject: { accountId: "github-work", uri: "github:acme/app/pull/42" },
    waitingItemIds: reason === "待っている" ? ["a1"] : [],
    revision: null,
    fingerprint: null,
    nextCheckAt: "2026-11-28T00:00:00Z",
  };
}

/** 自分の対象として、一覧に現れる（見張っていなければ、また見張る） */
export function listed(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(!target.mine, "一覧にないときだけ");
  return target.watching === "やめた" ? { ...target, ...START, mine: true } : { ...target, mine: true };
}

/**
 * 自分の対象の一覧から外れる（閉じた PR など）
 *
 * すぐには見張りをやめず、最後にもう一度確かめる（merge されて一覧から消えたのを、取りこぼさないため）。
 */
export function unlisted(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(target.mine, "一覧にあるときだけ");
  return { ...target, mine: false, due: "確かめる時刻" };
}

/** 待つ Action Item が増える（見張っていなければ、また見張る） */
export function addWaiter(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  const waiting: WatchTarget = { ...target, waiters: "あり", waitingItemIds: [...target.waitingItemIds, "a2"] };
  return target.watching === "やめた" ? { ...waiting, ...START } : waiting;
}

/**
 * 待つ Action Item が減る（待つ条件で果たされた・やらなくなった）
 *
 * ほかに待っている Action Item がなく、自分の対象でもなければ、見張らなくなる。
 */
export function removeWaiter(target: WatchTarget, actor: Actor, remaining: "ほかにも待っている" | "もういない"): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(target.waiters === "あり", "待っている Action Item があるときだけ");
  const waiters: Waiters = remaining === "ほかにも待っている" ? "あり" : "なし";
  const next = { ...target, waiters };
  return hasReason(next) ? next : { ...next, watching: "やめた" };
}

/** 確かめる時刻が来る（時間の条件が成り立つかもしれない時刻になったときも） */
export function becomeDue(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "clock", "時の流れだけ");
  ensure(target.watching === "見張っている", "見張っているときだけ");
  ensure(target.due === "まだ", "確かめる時刻が来ていないときだけ");
  return { ...target, due: "確かめる時刻" };
}

/** 一覧の更新を表す値が変わる（予定より前でも確かめ、間隔を最初に戻す。一覧で取る自分の対象だけ） */
export function revisionChanged(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(target.mine, "一覧にある自分の対象だけ");
  return { ...target, due: "確かめる時刻", interval: "最初" };
}

/**
 * 詳細を取って確かめる
 *
 * 変わらなければ間隔を延ばす（上限まで）。変わったら最初に戻す。分からない条件があるうちは延ばさない（GitHub が計算を終えたら、すぐ判定できるように）。
 * 見張る理由がもうなければ（一覧から外れたあとの最後の確認）、確かめたあと見張らなくなる。
 */
export function check(target: WatchTarget, actor: Actor, change: Change): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(target.watching === "見張っている", "見張っているときだけ");
  ensure(target.due === "確かめる時刻", "確かめる時刻が来たときだけ");
  const interval: Interval =
    change === "変わった" ? "最初" : change === "分からない条件がある" ? target.interval : change === "変わらない（上限に届く）" || target.interval === "上限" ? "上限" : "延ばしている";
  return { ...target, due: "まだ", interval, watching: hasReason(target) ? "見張っている" : "やめた" };
}

export const inputs = {
  initial: { 自分の対象: ["自分の対象"], 待っている: ["待っている"] },
  check: { 変わらない: ["変わらない"], 上限に届く: ["変わらない（上限に届く）"], 変わった: ["変わった"], 分からない: ["分からない条件がある"] },
  removeWaiter: { ほかにも待っている: ["ほかにも待っている"], もういない: ["もういない"] },
};

export const reviewed = {
  "anytime:addWaiter": "待つ Action Item は、いつでも増えうる。見張っていなければ、見張りを始め直す",
  "equivalent-states:見張っている · 最初 · 確かめる時刻 · mine · なし/見張っている · 延ばしている · 確かめる時刻 · mine · なし/見張っている · 上限 · 確かめる時刻 · mine · なし": "確認の間隔は、次に確かめる時刻（nextCheckAt）を決めるだけで、できる操作は変わらない。時刻を進めるのは時の流れ",
  "equivalent-states:見張っている · 最初 · 確かめる時刻 · あり/見張っている · 延ばしている · 確かめる時刻 · あり/見張っている · 上限 · 確かめる時刻 · あり": "確認の間隔は、次に確かめる時刻（nextCheckAt）を決めるだけで、できる操作は変わらない。時刻を進めるのは時の流れ",
  "equivalent-states:見張っている · 最初 · 確かめる時刻 · なし/見張っている · 延ばしている · 確かめる時刻 · なし/見張っている · 上限 · 確かめる時刻 · なし": "確認の間隔は、次に確かめる時刻（nextCheckAt）を決めるだけで、できる操作は変わらない。時刻を進めるのは時の流れ",
  "equivalent-states:見張っている · 最初 · 確かめる時刻 · mine · あり/見張っている · 延ばしている · 確かめる時刻 · mine · あり/見張っている · 上限 · 確かめる時刻 · mine · あり": "確認の間隔は、次に確かめる時刻（nextCheckAt）を決めるだけで、できる操作は変わらない。時刻を進めるのは時の流れ",
  "equivalent-states:見張っている · 延ばしている · まだ · mine · なし/見張っている · 上限 · まだ · mine · なし/見張っている · 最初 · まだ · mine · なし": "確認の間隔は、次に確かめる時刻（nextCheckAt）を決めるだけで、できる操作は変わらない。時刻を進めるのは時の流れ",
  "equivalent-states:やめた · 最初 · 確かめる時刻 · なし/やめた · 延ばしている · まだ · なし/やめた · 上限 · まだ · なし/やめた · 最初 · まだ · なし/やめた · 延ばしている · 確かめる時刻 · なし/やめた · 上限 · 確かめる時刻 · なし": "見張らなくなったら、間隔と確かめる時刻は意味を持たない（また見張るときは、最初の間隔から確かめ直す）",
  "equivalent-states:見張っている · 延ばしている · まだ · あり/見張っている · 上限 · まだ · あり/見張っている · 最初 · まだ · あり": "確認の間隔は、次に確かめる時刻（nextCheckAt）を決めるだけで、できる操作は変わらない。時刻を進めるのは時の流れ",
  "equivalent-states:見張っている · 延ばしている · まだ · mine · あり/見張っている · 上限 · まだ · mine · あり/見張っている · 最初 · まだ · mine · あり": "確認の間隔は、次に確かめる時刻（nextCheckAt）を決めるだけで、できる操作は変わらない。時刻を進めるのは時の流れ",
};

export const invariants = {
  "見張りをやめたのは、見張る理由が 1 つもないときだけ": (target: WatchTarget) => target.watching === "見張っている" || !hasReason(target),
  "見張る理由がないのに見張っているのは、最後に確かめる前だけ": (target: WatchTarget) => target.watching === "やめた" || hasReason(target) || target.due === "確かめる時刻",
  "見張る対象は、作ったあと変わらない": (before: WatchTarget, after: WatchTarget) => before.subject.accountId === after.subject.accountId && before.subject.uri === after.subject.uri,
};

export const links = [
  { from: check, to: "source-item", action: "update", label: "自分の対象なら、困った状態を事実の行（conflict: あり など）として届ける" },
  { from: check, to: "task", label: "待っている対象なら、待つ条件が成り立ったか・達成できないかを、待っている Action Item に知らせる" },
];

export const scenarios = {
  "放置している PR は、確認の間隔を延ばしていく": [
    { do: initial, by: "同期", input: "自分の対象", expect: { watching: "見張っている", interval: "最初", due: "確かめる時刻" } },
    { do: check, by: "同期", input: "変わらない", expect: { due: "まだ", interval: "延ばしている" } },
    { do: becomeDue, by: "時の流れ" },
    { do: check, by: "同期", input: "上限に届く", expect: { interval: "上限" } },
    { do: becomeDue, by: "時の流れ" },
    { do: check, by: "同期", input: "変わらない", expect: { interval: "上限" } },
  ],
  "動きがあれば、すぐ確かめて間隔を最初に戻す。分からないうちは延ばさない": [
    { do: initial, by: "同期", input: "自分の対象" },
    { do: check, by: "同期", input: "変わらない", expect: { interval: "延ばしている" } },
    { do: check, by: "同期", input: "変わらない", denied: "確かめる時刻が来たときだけ" },
    { do: revisionChanged, by: "同期", expect: { due: "確かめる時刻", interval: "最初" } },
    { do: check, by: "同期", input: "分からない", expect: { interval: "最初" } },
    { do: becomeDue, by: "時の流れ" },
    { do: check, by: "同期", input: "変わった", expect: { interval: "最初" } },
  ],
  "一覧から外れた自分の PR は、最後に確かめてから見張らない": [
    { do: initial, by: "同期", input: "自分の対象" },
    { do: check, by: "同期", input: "変わらない" },
    { do: listed, by: "同期", denied: "一覧にないときだけ" },
    { do: unlisted, by: "同期", expect: { mine: false, watching: "見張っている", due: "確かめる時刻" } },
    { do: unlisted, by: "同期", denied: "一覧にあるときだけ" },
    { do: revisionChanged, by: "同期", denied: "一覧にある自分の対象だけ" },
    { do: check, by: "同期", input: "変わった", expect: { watching: "やめた" } },
    { do: becomeDue, by: "時の流れ", denied: "見張っているときだけ" },
    { do: listed, by: "同期", expect: { watching: "見張っている", mine: true, interval: "最初" } },
  ],
  "待っている対象は、待つ Action Item がいなくなったら見張らない": [
    { do: initial, by: "同期", input: "待っている", expect: { waiters: "あり" } },
    { do: addWaiter, by: "同期", expect: { waiters: "あり" } },
    { do: removeWaiter, by: "同期", input: "ほかにも待っている", expect: { watching: "見張っている" } },
    { do: removeWaiter, by: "同期", input: "もういない", expect: { watching: "やめた", waiters: "なし" } },
    { do: removeWaiter, by: "同期", input: "もういない", denied: "待っている Action Item があるときだけ" },
    { do: check, by: "同期", input: "変わった", denied: "見張っているときだけ" },
    { do: addWaiter, by: "同期", expect: { watching: "見張っている", waiters: "あり" } },
  ],
  "自分の PR を待つこともある（理由が 2 つ）": [
    { do: initial, by: "同期", input: "自分の対象" },
    { do: addWaiter, by: "同期", expect: { mine: true, waiters: "あり" } },
    { do: removeWaiter, by: "同期", input: "もういない", expect: { watching: "見張っている" } },
  ],
  "時刻で進めるのは時の流れ、確かめるのは同期": [{ do: initial, by: "時の流れ", input: "自分の対象", denied: "同期だけ" }],
  "確認の操作は決まった人だけ": [
    { do: initial, by: "同期", input: "自分の対象" },
    { do: check, by: "時の流れ", input: "変わらない", denied: "同期だけ" },
    { do: check, by: "同期", input: "変わらない" },
    { do: becomeDue, by: "同期", denied: "時の流れだけ" },
    { do: becomeDue, by: "時の流れ" },
    { do: becomeDue, by: "時の流れ", denied: "確かめる時刻が来ていないときだけ" },
    { do: revisionChanged, by: "時の流れ", denied: "同期だけ" },
    { do: unlisted, by: "時の流れ", denied: "同期だけ" },
    { do: addWaiter, by: "時の流れ", denied: "同期だけ" },
    { do: removeWaiter, by: "時の流れ", input: "もういない", denied: "同期だけ" },
    { do: unlisted, by: "同期" },
    { do: listed, by: "時の流れ", denied: "同期だけ" },
  ],
};
