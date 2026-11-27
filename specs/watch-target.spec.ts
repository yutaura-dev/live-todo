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
  /** なぜ見張っているか（見張っていなければ「見張らない」） */
  reason: Reason;
  /** 次に確かめるまでの間隔（ミリ秒）。決め方は判断表「次の確認の間隔」 */
  intervalMs: number;
  /** 見張る対象（1 つの項目・検索・ワークフローの実行も、provider が決めた識別子で表す） */
  subject: Subject;
  /** 待っている Action Item */
  waitingItemIds: string[];
  /** 一覧で分かる、対象の更新を表す値（GitHub なら PR の updated_at）。変わったら予定より前でも確かめる */
  revision: string | null;
  /** 判定に効く値だけを並べたもの（provider が決める。GitHub の PR なら head の commit・mergeable・check・レビュー）。変わらなければ間隔を延ばす */
  fingerprint: string | null;
  /** 次に確かめる時刻。確かめたら間隔から決め、時間の条件が成り立つかもしれない時刻より遅らせない。動きがあったときや一覧から外れたときは、すぐに前倒しする */
  nextCheckAt: string;
};

export const Reason = {
  /** 自分が関わる開いている対象の一覧（GitHub なら、自分が作った PR・自分にレビュー依頼が来ている PR）に載っている。困った状態を見張る */
  problems: "困った状態",
  /** 待っている Action Item がある（一覧には載っていない） */
  waiting: "待っている",
  /** 一覧に載っていて、待っている Action Item もある */
  both: "両方",
  /** 一覧から外れた。待っている Action Item もないので、最後にもう一度確かめたら見張らない（merge されて一覧から消えたのを、取りこぼさないため） */
  lastCheck: "最後に確かめる",
  /** 見張らない */
  none: "見張らない",
} as const;
export type Reason = (typeof Reason)[keyof typeof Reason];

/** 確かめて分かった、対象の変化（間隔を決めるためのもの。条件が成り立ったかの判定は、届け先が受け取る） */
type Change = "変わらない" | "変わった" | "分からない条件がある";
/** 次に確かめる時刻を過ぎたか */
type Timing = "次に確かめる時刻を過ぎた" | "まだ";
type Actor = { kind: "sync" };

export const actors: Record<string, Actor> = {
  同期: { kind: "sync" },
};

const NOW = "2026-11-28T00:00:00Z";
const INITIAL_MS = 5 * 60 * 1000;
const MAX_MS = 24 * 60 * 60 * 1000;
const RESTART = { intervalMs: INITIAL_MS, nextCheckAt: NOW } as const;

const inList = (reason: Reason) => reason === "困った状態" || reason === "両方";
const waiting = (reason: Reason) => reason === "待っている" || reason === "両方";

/** 見張りを始める（自分の対象が一覧に初めて現れた・待つ条件の Action Item ができた） */
export function initial(actor: Actor, reason: "困った状態" | "待っている"): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  return {
    reason,
    ...RESTART,
    subject: { accountId: "github-work", uri: "github:acme/app/pull/42" },
    waitingItemIds: reason === "待っている" ? ["a1"] : [],
    revision: null,
    fingerprint: null,
  };
}

/** 自分の対象として、一覧に現れる（見張っていなければ、また見張る） */
export function listed(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(!inList(target.reason), "一覧に載っていないときだけ");
  return waiting(target.reason) ? { ...target, reason: "両方" } : { ...target, ...RESTART, reason: "困った状態" };
}

/**
 * 自分の対象の一覧から外れる（閉じた PR など）
 *
 * 待っている Action Item がなければ、すぐには見張りをやめず、最後にもう一度確かめる（次に確かめる時刻をすぐに前倒しする）。
 */
export function unlisted(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(inList(target.reason), "一覧に載っているときだけ");
  return target.reason === "両方" ? { ...target, reason: "待っている" } : { ...target, reason: "最後に確かめる", nextCheckAt: NOW };
}

/** 待つ Action Item が増える（見張っていなければ、また見張る） */
export function addWaiter(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  if (target.reason === "見張らない") return { ...target, ...RESTART, reason: "待っている", waitingItemIds: [...target.waitingItemIds, "a2"] };
  return { ...target, reason: inList(target.reason) ? "両方" : "待っている", waitingItemIds: [...target.waitingItemIds, "a2"] };
}

/** 待つ Action Item が減る（待つ条件で果たされた・やらなくなった） */
export function removeWaiter(target: WatchTarget, actor: Actor, remaining: "ほかにも待っている" | "もういない"): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(waiting(target.reason), "待っている Action Item があるときだけ");
  if (remaining === "ほかにも待っている") return { ...target };
  return { ...target, reason: target.reason === "両方" ? "困った状態" : "見張らない" };
}

/** 一覧の更新を表す値が変わる（次に確かめる時刻をすぐに前倒しし、間隔を最初に戻す。一覧で取る自分の対象だけ） */
export function revisionChanged(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(inList(target.reason), "一覧に載っている自分の対象だけ");
  return { ...target, ...RESTART };
}

/**
 * 詳細を取って確かめる
 *
 * 次の間隔は、判断表「次の確認の間隔」で決める。最後に確かめる対象は、確かめたら見張らなくなる。
 * 困った状態を見張っているなら、困った状態を事実の行として Source Item に届ける。待っているなら、待つ条件が成り立ったかを Action Item に知らせる。
 */
export function check(target: WatchTarget, actor: Actor, timing: Timing, _change: Change): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(target.reason !== "見張らない", "見張っているときだけ");
  ensure(timing === "次に確かめる時刻を過ぎた", "次に確かめる時刻を過ぎたときだけ");
  return { ...target, nextCheckAt: "2026-11-28T01:00:00Z", reason: target.reason === "最後に確かめる" ? "見張らない" : target.reason };
}

/** 次の確認の間隔 */
function nextInterval(currentMs: number, change: Change): number {
  if (change === "変わった") return INITIAL_MS;
  if (change === "分からない条件がある") return currentMs;
  return Math.min(currentMs * 2, MAX_MS);
}

/**
 * 判断表。確かめた結果から、次の確認の間隔を決める（ADR-0009）。
 * 変わらなければ倍に延ばし（最初 5 分、上限 1 日）、変わったら最初に戻す。分からない条件があるうちは延ばさない（GitHub が計算を終えたら、すぐ判定できるように）。
 */
export const decisions = {
  次の確認の間隔: {
    decide: (input: { 今の間隔: string; 確かめた結果: Change }) => {
      const ms = input.今の間隔 === "5 分" ? INITIAL_MS : input.今の間隔 === "1 時間" ? 60 * 60 * 1000 : input.今の間隔 === "16 時間" ? 16 * 60 * 60 * 1000 : MAX_MS;
      const next = nextInterval(ms, input.確かめた結果);
      return next >= MAX_MS ? "1 日（上限）" : next >= 60 * 60 * 1000 ? `${next / (60 * 60 * 1000)} 時間` : `${next / (60 * 1000)} 分`;
    },
    cases: [
      { input: { 今の間隔: "5 分", 確かめた結果: "変わらない" }, expect: "10 分" },
      { input: { 今の間隔: "1 時間", 確かめた結果: "変わらない" }, expect: "2 時間" },
      { input: { 今の間隔: "16 時間", 確かめた結果: "変わらない" }, expect: "1 日（上限）" },
      { input: { 今の間隔: "1 日", 確かめた結果: "変わらない" }, expect: "1 日（上限）" },
      { input: { 今の間隔: "1 日", 確かめた結果: "変わった" }, expect: "5 分" },
      { input: { 今の間隔: "1 時間", 確かめた結果: "分からない条件がある" }, expect: "1 時間" },
    ],
  },
};

export const inputs = {
  initial: { 困った状態: ["困った状態"], 待っている: ["待っている"] },
  check: {
    変わらない: ["次に確かめる時刻を過ぎた", "変わらない"],
    変わった: ["次に確かめる時刻を過ぎた", "変わった"],
    分からない: ["次に確かめる時刻を過ぎた", "分からない条件がある"],
    まだ時刻前: ["まだ", "変わった"],
  },
  removeWaiter: { ほかにも待っている: ["ほかにも待っている"], もういない: ["もういない"] },
};

export const invariants = {
  "見張る対象は、作ったあと変わらない": (before: WatchTarget, after: WatchTarget) => before.subject.accountId === after.subject.accountId && before.subject.uri === after.subject.uri,
};

export const links = [
  { from: check, to: "source-item", action: "update", label: "自分の対象なら、困った状態を事実の行（conflict: あり など）として届ける" },
  { from: check, to: "task", label: "待っている対象なら、待つ条件が成り立ったか・達成できないかを、待っている Action Item に知らせる" },
];

export const scenarios = {
  "確かめる時刻が来たら確かめる": [
    { do: initial, by: "同期", input: "困った状態", expect: { reason: "困った状態" } },
    { do: check, by: "同期", input: "まだ時刻前", denied: "次に確かめる時刻を過ぎたときだけ" },
    { do: check, by: "同期", input: "変わらない", expect: { reason: "困った状態" } },
    { do: revisionChanged, by: "同期" },
    { do: check, by: "同期", input: "分からない" },
  ],
  "一覧から外れた自分の PR は、最後に確かめてから見張らない": [
    { do: initial, by: "同期", input: "困った状態" },
    { do: listed, by: "同期", denied: "一覧に載っていないときだけ" },
    { do: unlisted, by: "同期", expect: { reason: "最後に確かめる" } },
    { do: unlisted, by: "同期", denied: "一覧に載っているときだけ" },
    { do: revisionChanged, by: "同期", denied: "一覧に載っている自分の対象だけ" },
    { do: check, by: "同期", input: "変わった", expect: { reason: "見張らない" } },
    { do: check, by: "同期", input: "変わった", denied: "見張っているときだけ" },
    { do: listed, by: "同期", expect: { reason: "困った状態" } },
  ],
  "待っている対象は、待つ Action Item がいなくなったら見張らない": [
    { do: initial, by: "同期", input: "待っている", expect: { reason: "待っている" } },
    { do: addWaiter, by: "同期", expect: { reason: "待っている" } },
    { do: removeWaiter, by: "同期", input: "ほかにも待っている", expect: { reason: "待っている" } },
    { do: removeWaiter, by: "同期", input: "もういない", expect: { reason: "見張らない" } },
    { do: removeWaiter, by: "同期", input: "もういない", denied: "待っている Action Item があるときだけ" },
    { do: addWaiter, by: "同期", expect: { reason: "待っている" } },
  ],
  "自分の PR を待つこともある（理由が両方）": [
    { do: initial, by: "同期", input: "困った状態" },
    { do: addWaiter, by: "同期", expect: { reason: "両方" } },
    { do: unlisted, by: "同期", expect: { reason: "待っている" } },
    { do: listed, by: "同期", expect: { reason: "両方" } },
    { do: removeWaiter, by: "同期", input: "もういない", expect: { reason: "困った状態" } },
  ],
  "最後に確かめる前に、また待つことになった": [
    { do: initial, by: "同期", input: "困った状態" },
    { do: unlisted, by: "同期", expect: { reason: "最後に確かめる" } },
    { do: addWaiter, by: "同期", expect: { reason: "待っている" } },
  ],
};

export const reviewed = {
  "indistinguishable-example:check:変わらない,変わった,分からない": "確かめた結果で変わるのは次の確認の間隔だけで、判断表「次の確認の間隔」で決まる。見張っているか・見張る理由は変わらない",
  "anytime:addWaiter": "待つ Action Item は、いつでも増えうる。見張っていなければ、見張りを始め直す",
};
