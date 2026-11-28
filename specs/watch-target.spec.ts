import { ensure } from "@yutaura/live-spec";
import type { Subject } from "./condition.value.ts";

/**
 * Watcher が見張る対象 1 つ（ADR-0008・0009）。同じ対象は 1 つだけ持つ（対象で探し、あれば理由を足す）。
 * 見張る理由は 2 つある。
 * - 関わっている: 自分が関わっている開いている対象の一覧（GitHub なら、自分が作った PR・自分にレビュー依頼が来ている PR）に載っている。一覧からは分からない状態（conflict しているか・CI の結果・レビューの状態など）を確かめて、事実の行として Source Item に届ける。それが自分に行動を求めるかは、振り分けと Task が判断する
 * - 待っている: 待つ条件の Action Item が指している（他人の PR・deploy の PR を探す検索・ワークフローの実行など）。待っている Action Item がある間だけ見張る
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
  /** 待っている Action Item（どの Task の、どの Action Item か） */
  waitingItems: WaitingItem[];
  /** 一覧で分かる、対象の更新を表す値（GitHub なら PR の updated_at）。変わったら予定より前でも確かめる */
  revision: string | null;
  /** 判定に効く値だけを並べたもの（provider が決める。GitHub の PR なら head の commit・mergeable・check・レビュー）。変わらなければ間隔を延ばす */
  fingerprint: string | null;
  /** アカウントのつなぎ直しが要るので、確かめるのを止めているか（つないだら続きから確かめる） */
  paused: boolean;
  /** 次に確かめる時刻。確かめたら間隔から決め、時間の条件が成り立つかもしれない時刻より遅らせない。動きがあったときや一覧から外れたときは、すぐに前倒しする */
  nextCheckAt: string;
};

/** 待っている Action Item（Action Item の ID は Task の中でだけ一意なので、Task と組で指す） */
export type WaitingItem = {
  /** @ref task */
  taskId: string;
  actionItemId: string;
};

export const Reason = {
  /** 自分が関わっている開いている対象の一覧に載っている。一覧からは分からない状態を確かめて、事実の行として届ける */
  involved: "関わっている",
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

/** 確かめて分かった、対象の変化（間隔を決めるためのもの。待つ条件が成り立ったかや事実の中身は、届け先が受け取る） */
type Change = "変わらない" | "変わった" | "分からない値がある";
/** 待つ Action Item（spec では 2 つで代表させる） */
type ItemExample = "Task 1 の Action Item" | "Task 2 の Action Item";
/** 次に確かめる時刻を過ぎたか */
type Timing = "次に確かめる時刻を過ぎた" | "まだ";
type Actor = { kind: "sync" } | { kind: "app" };

export const actors: Record<string, Actor> = {
  同期: { kind: "sync" },
  アプリ: { kind: "app" },
};

const NOW = "2026-11-28T00:00:00Z";
const INITIAL_MS = 5 * 60 * 1000;
const RESTART = { intervalMs: INITIAL_MS, nextCheckAt: NOW } as const;
const ITEMS: Record<ItemExample, WaitingItem> = {
  "Task 1 の Action Item": { taskId: "t1", actionItemId: "a1" },
  "Task 2 の Action Item": { taskId: "t2", actionItemId: "a1" },
};

const inList = (reason: Reason) => reason === "関わっている" || reason === "両方";
const sameItem = (a: WaitingItem, b: WaitingItem) => a.taskId === b.taskId && a.actionItemId === b.actionItemId;

/** 見張りを始める（関わっている対象が一覧に初めて現れた・待つ条件の Action Item ができた。同じ対象の見張りがなければ作る） */
export function initial(actor: Actor, reason: "関わっている" | "待っている"): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  return {
    reason,
    ...RESTART,
    subject: { uri: "github://yutaura@github.com/acme/app/pull/42" },
    waitingItems: reason === "待っている" ? [ITEMS["Task 1 の Action Item"]] : [],
    revision: null,
    fingerprint: null,
    paused: false,
  };
}

/** 関わっている対象として、一覧に現れる（見張っていなければ、また見張る） */
export function listed(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(!inList(target.reason), "一覧に載っていないときだけ");
  return target.waitingItems.length > 0 ? { ...target, reason: "両方" } : { ...target, ...RESTART, reason: "関わっている" };
}

/**
 * 関わっている対象の一覧から外れる（merge された・閉じた PR など）
 *
 * 理由によらず、次に確かめる時刻をすぐに前倒しし、間隔を最初に戻す（merge されて一覧から消えたのを、取りこぼさないため）。
 * 待っている Action Item がなければ、最後にもう一度確かめたら見張らなくなる。
 */
export function unlisted(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(inList(target.reason), "一覧に載っているときだけ");
  return { ...target, ...RESTART, reason: target.waitingItems.length > 0 ? "待っている" : "最後に確かめる" };
}

/**
 * 待つ Action Item が増える
 *
 * 待っている Action Item は、Task と Action Item の順に並べて持つ（足した順で別のものにならないように）。
 * 見張っていなければ、また見張る。見張っていても、間隔を最初に戻す（待つ人が増えたので、早く気づけるように）。すでに待っている Action Item なら、何もしない。
 */
export function addWaiter(target: WatchTarget, actor: Actor, item: ItemExample): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  if (target.waitingItems.some((w) => sameItem(w, ITEMS[item]))) return target;
  return { ...target, ...RESTART, reason: inList(target.reason) ? "両方" : "待っている", waitingItems: [...target.waitingItems, ITEMS[item]].sort((a, b) => (a.taskId + a.actionItemId).localeCompare(b.taskId + b.actionItemId)) };
}

/**
 * 待つ Action Item が減る（待つ条件の結果が出た・やらなくなった）
 *
 * ほかに待っている Action Item がなく、関わっている対象でもなければ、見張らなくなる。
 */
export function removeWaiter(target: WatchTarget, actor: Actor, item: ItemExample): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(target.waitingItems.some((w) => sameItem(w, ITEMS[item])), "その Action Item が待っているときだけ");
  const rest = target.waitingItems.filter((w) => !sameItem(w, ITEMS[item]));
  const reason: Reason = rest.length > 0 ? target.reason : target.reason === "両方" ? "関わっている" : "見張らない";
  return { ...target, reason, waitingItems: rest };
}

/** 一覧の更新を表す値が変わる（次に確かめる時刻をすぐに前倒しし、間隔を最初に戻す。一覧に載っている対象だけ） */
export function revisionChanged(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(inList(target.reason), "一覧に載っている対象だけ");
  return { ...target, ...RESTART };
}

/**
 * 詳細を取って確かめる
 *
 * 次の間隔は、判断表「次の確認の間隔」で決める。最後に確かめる対象は、確かめたら見張らなくなる。
 * 関わっている対象なら、確かめた状態を事実の行として Source Item に届ける。待っている対象なら、待つ条件が成り立ったかを、待っている Action Item に知らせる。
 * 分からない値があるときは、前に確かめた結果を引き継ぐ（事実の行を変えない・待つ条件の結果も出さない）。
 */
export function check(target: WatchTarget, actor: Actor, timing: Timing, _change: Change): WatchTarget {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(target.reason !== "見張らない", "見張っているときだけ");
  ensure(!target.paused, "止めていないときだけ（つなぎ直しが要るアカウントの対象は確かめない）");
  ensure(timing === "次に確かめる時刻を過ぎた", "次に確かめる時刻を過ぎたときだけ");
  return { ...target, nextCheckAt: "2026-11-28T01:00:00Z", reason: target.reason === "最後に確かめる" ? "見張らない" : target.reason };
}

const HOUR = 60 * 60 * 1000;

/** 次の確認の間隔。待っているだけの対象は、Task が先へ進めないので、上限を短くする */
function nextInterval(currentMs: number, change: Change, reason: "関わっている" | "待っている"): number {
  const max = reason === "待っている" ? HOUR : 24 * HOUR;
  if (change === "変わった") return INITIAL_MS;
  if (change === "分からない値がある") return currentMs;
  return Math.min(currentMs * 2, max);
}

/**
 * 判断表。確かめた結果から、次の確認の間隔を決める（ADR-0009）。
 * 変わらなければ倍に延ばし（最初 5 分）、変わったら最初に戻す。分からない値があるうちは延ばさない（GitHub が計算を終えたら、すぐ判定できるように）。
 * 上限は、関わっている対象は 1 日、待っているだけの対象は 1 時間（他人の PR の merge を待つと、Task が先へ進めないため）。両方なら待っている側の上限を使う。
 */
export const decisions = {
  次の確認の間隔: {
    decide: (input: { 見張る理由: "関わっている" | "待っている"; 今の間隔: string; 確かめた結果: Change }) => {
      const ms = input.今の間隔 === "5 分" ? INITIAL_MS : input.今の間隔 === "1 時間" ? HOUR : input.今の間隔 === "16 時間" ? 16 * HOUR : 24 * HOUR;
      const next = nextInterval(ms, input.確かめた結果, input.見張る理由);
      return next >= 24 * HOUR ? "1 日（上限）" : next === HOUR && input.見張る理由 === "待っている" && input.確かめた結果 === "変わらない" ? "1 時間（上限）" : next >= HOUR ? `${next / HOUR} 時間` : `${next / (60 * 1000)} 分`;
    },
    cases: [
      { input: { 見張る理由: "関わっている", 今の間隔: "5 分", 確かめた結果: "変わらない" }, expect: "10 分" },
      { input: { 見張る理由: "関わっている", 今の間隔: "1 時間", 確かめた結果: "変わらない" }, expect: "2 時間" },
      { input: { 見張る理由: "関わっている", 今の間隔: "16 時間", 確かめた結果: "変わらない" }, expect: "1 日（上限）" },
      { input: { 見張る理由: "関わっている", 今の間隔: "1 日", 確かめた結果: "変わった" }, expect: "5 分" },
      { input: { 見張る理由: "関わっている", 今の間隔: "1 時間", 確かめた結果: "分からない値がある" }, expect: "1 時間" },
      { input: { 見張る理由: "待っている", 今の間隔: "5 分", 確かめた結果: "変わらない" }, expect: "10 分" },
      { input: { 見張る理由: "待っている", 今の間隔: "1 時間", 確かめた結果: "変わらない" }, expect: "1 時間（上限）" },
    ],
  },
};

/** アカウントのつなぎ直しが要るので、確かめるのを止める（Account の「つなぎ直しが要る」からの反応） */
export function pause(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(!target.paused, "止めていないときだけ");
  return { ...target, paused: true };
}

/** アカウントをつないだので、続きから確かめる（すぐ確かめる。Account の「つなぐ」からの反応） */
export function resume(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(target.paused, "止めているときだけ");
  return { ...target, paused: false, nextCheckAt: "2026-11-28T00:00:00Z" };
}

/** アカウントを外したので、見張らない（待っている Action Item には、達成できないと知らせる） */
export function drop(target: WatchTarget, actor: Actor): WatchTarget {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(target.reason !== "見張らない", "見張っているときだけ");
  return { ...target, reason: "見張らない", waitingItems: [], paused: false };
}

export const inputs = {
  initial: { 関わっている: ["関わっている"], 待っている: ["待っている"] },
  addWaiter: { "Task 1": ["Task 1 の Action Item"], "Task 2": ["Task 2 の Action Item"] },
  removeWaiter: { "Task 1": ["Task 1 の Action Item"], "Task 2": ["Task 2 の Action Item"] },
  check: {
    変わらない: ["次に確かめる時刻を過ぎた", "変わらない"],
    変わった: ["次に確かめる時刻を過ぎた", "変わった"],
    分からない: ["次に確かめる時刻を過ぎた", "分からない値がある"],
    まだ時刻前: ["まだ", "変わった"],
  },
};

export const invariants = {
  "待っている・両方なのは、待っている Action Item があるときだけ": (target: WatchTarget) => (target.reason === "待っている" || target.reason === "両方") === target.waitingItems.length > 0,
  "見張る対象は、作ったあと変わらない": (before: WatchTarget, after: WatchTarget) => before.subject.uri === after.subject.uri,
};

export const links = [
  { from: drop, to: "task", label: "待っていた Action Item に、待つ条件が達成できないと知らせる（理由: アカウントを外した。Action Item の observeCondition）" },
  { from: listed, to: "source-item", label: "関わっている対象の事実がまだなければ、取り込む" },
  { from: check, to: "source-item", action: "update", label: "関わっている対象なら、確かめた状態（conflict: あり など）を事実の行として届ける" },
  { from: check, to: "source-item", action: "remove", label: "最後に確かめた対象は、事実を変えてから、範囲の外になったとして消す" },
  { from: check, to: "task", label: "待っている対象なら、待つ条件が成り立ったか・達成できないかを、待っている Action Item に知らせる（Action Item の observeCondition）" },
];

export const scenarios = {
  "一覧と確かめるのは同期、アカウントの変化を伝えるのはアプリだけ": [
    { do: initial, by: "同期", input: "関わっている" },
    { do: unlisted, by: "アプリ", denied: "同期だけ" },
    { do: addWaiter, by: "アプリ", input: "Task 1", denied: "同期だけ" },
    { do: addWaiter, by: "同期", input: "Task 1" },
    { do: removeWaiter, by: "アプリ", input: "Task 1", denied: "同期だけ" },
    { do: revisionChanged, by: "アプリ", denied: "同期だけ" },
    { do: check, by: "アプリ", input: "変わった", denied: "同期だけ" },
    { do: pause, by: "アプリ" },
    { do: resume, by: "同期", denied: "アプリだけ" },
    { do: unlisted, by: "同期" },
    { do: listed, by: "アプリ", denied: "同期だけ" },
  ],
  "つなぎ直しが要るあいだは確かめず、つないだら続きから確かめる": [
    { do: initial, by: "同期", input: "待っている" },
    { do: resume, by: "アプリ", denied: "止めているときだけ" },
    { do: pause, by: "同期", denied: "アプリだけ" },
    { do: pause, by: "アプリ", expect: { paused: true } },
    { do: pause, by: "アプリ", denied: "止めていないときだけ" },
    { do: check, by: "同期", input: "変わった", denied: "止めていないときだけ（つなぎ直しが要るアカウントの対象は確かめない）" },
    { do: resume, by: "アプリ", expect: { paused: false } },
  ],
  "アカウントを外したら見張らない": [
    { do: initial, by: "同期", input: "待っている" },
    { do: drop, by: "同期", denied: "アプリだけ" },
    { do: drop, by: "アプリ", expect: { reason: "見張らない" } },
    { do: drop, by: "アプリ", denied: "見張っているときだけ" },
  ],
  "確かめる時刻が来たら確かめる": [
    { do: initial, by: "同期", input: "関わっている", expect: { reason: "関わっている" } },
    { do: check, by: "同期", input: "まだ時刻前", denied: "次に確かめる時刻を過ぎたときだけ" },
    { do: check, by: "同期", input: "変わらない", expect: { reason: "関わっている" } },
    { do: revisionChanged, by: "同期" },
    { do: check, by: "同期", input: "分からない" },
  ],
  "一覧から外れた関わっている対象は、最後に確かめてから見張らない": [
    { do: initial, by: "同期", input: "関わっている" },
    { do: listed, by: "同期", denied: "一覧に載っていないときだけ" },
    { do: unlisted, by: "同期", expect: { reason: "最後に確かめる" } },
    { do: unlisted, by: "同期", denied: "一覧に載っているときだけ" },
    { do: revisionChanged, by: "同期", denied: "一覧に載っている対象だけ" },
    { do: check, by: "同期", input: "変わった", expect: { reason: "見張らない" } },
    { do: check, by: "同期", input: "変わった", denied: "見張っているときだけ" },
    { do: listed, by: "同期", expect: { reason: "関わっている" } },
  ],
  "待っている対象は、待つ Action Item がいなくなったら見張らない": [
    { do: initial, by: "同期", input: "待っている", expect: { reason: "待っている" } },
    { do: addWaiter, by: "同期", input: "Task 2", expect: { reason: "待っている" } },
    { do: addWaiter, by: "同期", input: "Task 2", expect: { reason: "待っている" } },
    { do: removeWaiter, by: "同期", input: "Task 1", expect: { reason: "待っている" } },
    { do: removeWaiter, by: "同期", input: "Task 1", denied: "その Action Item が待っているときだけ" },
    { do: removeWaiter, by: "同期", input: "Task 2", expect: { reason: "見張らない" } },
    { do: addWaiter, by: "同期", input: "Task 1", expect: { reason: "待っている" } },
  ],
  "自分の PR の merge を待つ（理由が両方）。merge で一覧から外れたら、すぐ確かめる": [
    { do: initial, by: "同期", input: "関わっている" },
    { do: addWaiter, by: "同期", input: "Task 1", expect: { reason: "両方" } },
    { do: unlisted, by: "同期", expect: { reason: "待っている", nextCheckAt: "2026-11-28T00:00:00Z" } },
    { do: listed, by: "同期", expect: { reason: "両方" } },
    { do: removeWaiter, by: "同期", input: "Task 1", expect: { reason: "関わっている" } },
  ],
  "最後に確かめる前に、また待つことになった": [
    { do: initial, by: "同期", input: "関わっている" },
    { do: unlisted, by: "同期", expect: { reason: "最後に確かめる" } },
    { do: addWaiter, by: "同期", input: "Task 1", expect: { reason: "待っている" } },
  ],
};

export const reviewed = {
  "indistinguishable-example:check:変わらない,変わった,分からない": "確かめた結果で変わるのは次の確認の間隔だけで、判断表「次の確認の間隔」で決まる。見張っているか・見張る理由は変わらない",
  "anytime:addWaiter": "待つ Action Item は、いつでも増えうる。見張っていなければ、見張りを始め直す",
};
