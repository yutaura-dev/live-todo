import { ensure } from "@yutaura/live-spec";

/**
 * Sync（Source の取り込み 1 つ。アカウントごと・取り込む種類ごとに 1 つ）。決まった間隔でカーソルより後の変化を取り込み、Source Item に反映する（ADR-0003）。
 * 差分を返せる Source（Gmail の historyId など）はそれを使い、返せない Source は全件を取って、前回の fingerprint と比べて変化にする（SnapshotDiffer）。どちらも「カーソルより後の変化」にそろえる。
 * 取り込みは読むだけなので、失敗しても次の回にやり直せばよい（二重に取り込んでも、同じ事実はアカウントと uri で 1 つにまとまる）。
 * アカウント×種類ごとに 1 つだけで、見分ける値（アカウント・種類）は作ったあと変わらない。
 * 初めの取り込み（つないだとき・カーソルを捨てたとき）は、開いているもの（未読・開いている PR・保存したもの）だけを取り、過去のものはまとめて取り込まない。
 * 取り込む間隔は Source ごとに決まった値で、失敗が続いたら倍ずつ延ばす（上限 30 分。判断表「次に取りに行くまで」）。3 回続けて取り込めなかったら、ボードに印を出して知らせる（続いた回数は取り込みの記録に残し、ここでは持たない）。
 */
export type Sync = {
  /** 取り込みの段階 */
  status: Status;
  /** どのアカウントか */
  /** @ref account */
  accountId: string;
  /** 何を取り込むか（Gmail の受信箱・GitHub の通知・Slack の保存したもの など） */
  stream: string;
  /** どこまで取り込んだか（Source ごとの形。まだ一度も取り込んでいなければ null で、初めの取り込みをする） */
  cursor: unknown;
  /** 次に取りに行く時刻 */
  nextRunAt: string;
  /** 最後に失敗した理由（うまくいったら消す） */
  lastError: SyncError | "トークンが通らない" | null;
};

/** 取り込めなかった理由。想定外の応答（形に合わない・全件取得の途中でページが切れた）も、成功とは扱わない（fail closed） */
export type SyncError = "回数の上限" | "ネットワーク" | "Source のエラー" | "想定外の応答";

export const Status = {
  /** 次の回を待っている */
  waiting: "待っている",
  /** 取り込んでいる */
  running: "取り込んでいる",
  /** 一度に大量に消えたので、反映を止めてユーザーに確かめている（権限の範囲が変わって空の一覧が返った などで、まとめて消さないため） */
  confirming: "確かめている",
  /** アカウントのつなぎ直しが要るので止めている（つなぎ直したら再開する） */
  paused: "止めている",
  /** アカウントを外したので、もう取り込まない */
  ended: "やめた",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "app" } | { kind: "source" } | { kind: "user" };

/** アプリ: 時刻が来たら取りに行く・アカウントの変化を伝える。Source: 取りに行った結果（Source の応答を、アプリが記録する） */
export const actors: Record<string, Actor> = {
  アプリ: { kind: "app" },
  Source: { kind: "source" },
  ユーザー: { kind: "user" },
};

const NOW = "2026-11-28T00:00:00Z";

/** アカウントをつないだので、取り込みを始める（すぐ初めの取り込みをする） */
export function initial(actor: Actor): Sync {
  ensure(actor.kind === "app", "アプリだけ");
  return { status: "待っている", accountId: "gmail-private", stream: "受信箱", cursor: null, nextRunAt: NOW, lastError: null };
}

/** 次に取りに行く時刻が来たので、取り込む */
export function start(sync: Sync, actor: Actor, timing: "時刻を過ぎた" | "まだ"): Sync {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(sync.status === "待っている", "待っているときだけ");
  ensure(timing === "時刻を過ぎた", "次に取りに行く時刻を過ぎたときだけ");
  return { ...sync, status: "取り込んでいる" };
}

/**
 * 取り込めた（カーソルを進め、次の回は決まった間隔のあと）
 *
 * カーソルを進めるのは、変化を Source Item に反映するのと同じときだけ（反映だけが失敗して、カーソルだけ進むと取りこぼすため）。全件取得の Source は、全件が取れたときだけ取り込めたとする。
 * カーソルを捨てたあとの初めの取り込みでは、このアカウント×種類で「あり」の Source Item と突き合わせ、今回届かなかったものは消えた（範囲の外）にする（捨てている間に閉じた・消えたものを取りこぼさないため）。
 * 消えたことにするのは、同じアカウントのどの種類にも見えなくなった事実だけ（受信箱から外れてもラベルに残っていれば消さない。どの種類に見えているかは Source Item の側で持つ）。
 * 一度に大量に消えた（判断表「一度に大量に消えたか」）なら、反映もカーソルも止めて、ユーザーに確かめる。
 */
export function succeed(sync: Sync, actor: Actor, removal: "ふつう" | "一度に大量に消えた"): Sync {
  ensure(actor.kind === "source", "Source だけ");
  ensure(sync.status === "取り込んでいる", "取り込んでいるときだけ");
  if (removal === "一度に大量に消えた") return { ...sync, status: "確かめている" };
  return { ...sync, status: "待っている", cursor: { historyId: "12345" }, nextRunAt: "2026-11-28T00:01:00Z", lastError: null };
}

/**
 * 取り込めなかった（回数の上限・ネットワーク・Source のエラー・想定外の応答）
 *
 * カーソルは進めない。回数の上限なら、Source が言った時刻まで待つ。それ以外は、決まった間隔のあとにやり直す。
 */
export function fail(sync: Sync, actor: Actor, error: SyncError): Sync {
  ensure(actor.kind === "source", "Source だけ");
  ensure(sync.status === "取り込んでいる", "取り込んでいるときだけ");
  return { ...sync, status: "待っている", nextRunAt: error === "回数の上限" ? "2026-11-28T00:15:00Z" : "2026-11-28T00:01:00Z", lastError: error };
}

/**
 * カーソルが古すぎて使えない（Gmail の historyId が期限切れ など）・保存したカーソルが読めない
 *
 * カーソルを捨て、初めの取り込みからやり直す（取りこぼさないため）。
 */
export function resetCursor(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "source", "Source だけ");
  ensure(sync.status === "取り込んでいる", "取り込んでいるときだけ");
  return { ...sync, status: "待っている", cursor: null, nextRunAt: NOW };
}

/** ユーザーが、大量に消えたのを確かめて反映する（本当に消えた）。カーソルを進める */
export function confirmRemoval(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(sync.status === "確かめている", "確かめているときだけ");
  return { ...sync, status: "待っている", cursor: { historyId: "12345" }, nextRunAt: "2026-11-28T00:01:00Z", lastError: null };
}

/** ユーザーが、大量に消えたのは間違いだとする（反映せず、カーソルも進めず、次の回にやり直す） */
export function rejectRemoval(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(sync.status === "確かめている", "確かめているときだけ");
  return { ...sync, status: "待っている", nextRunAt: "2026-11-28T00:01:00Z", lastError: "想定外の応答" };
}

/** トークンが通らなかった（アカウントを、つなぎ直しが要るにする） */
export function reject(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "source", "Source だけ");
  ensure(sync.status === "取り込んでいる", "取り込んでいるときだけ");
  return { ...sync, status: "止めている", lastError: "トークンが通らない" };
}

/** 取り込んでいる間にアプリが止まった（起動したときに、取り込んでいるのまま残っていた）。カーソルは進めずに、すぐやり直す */
export function interrupt(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(sync.status === "取り込んでいる", "取り込んでいるときだけ");
  return { ...sync, status: "待っている", nextRunAt: NOW };
}

/** アカウントをつなぎ直したので、再開する（すぐ取りに行く。Account の「つなぐ」からの反応） */
export function resume(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(sync.status === "止めている", "止めているときだけ");
  return { ...sync, status: "待っている", nextRunAt: NOW };
}

/** アカウントを外したので、取り込みをやめる（Account の「外す」からの反応） */
export function end(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(sync.status !== "やめた", "やめていないときだけ");
  return { ...sync, status: "やめた" };
}

export const inputs = {
  start: { 時刻を過ぎた: ["時刻を過ぎた"], まだ: ["まだ"] },
  succeed: { ふつう: ["ふつう"], 大量に消えた: ["一度に大量に消えた"] },
  fail: { 回数の上限: ["回数の上限"], ネットワーク: ["ネットワーク"], "Source のエラー": ["Source のエラー"], 想定外の応答: ["想定外の応答"] },
};

export const invariants = {
  "やめた取り込みは、もう変わらない": (before: Sync, after: Sync) => before.status !== "やめた" || after.status === "やめた",
  "見分ける値（アカウント・種類）は、作ったあと変わらない": (before: Sync, after: Sync) => before.accountId === after.accountId && before.stream === after.stream,
};

export const links = [
  { from: succeed, to: "source-item", label: "カーソルより後の変化を、Source Item に反映する（取り込む・変わる・消える・また現れる）。一度に大量に消えたなら、確かめるまで反映しない" },
  { from: confirmRemoval, to: "source-item", label: "確かめた変化を、Source Item に反映する" },
  { from: reject, to: "account", action: "reject", label: "アカウントを、つなぎ直しが要るにする（理由: トークンが通らない）" },
];

/** 次に取りに行くまで（Source ごとの決まった間隔を、失敗が続いたら倍ずつ延ばす。上限 30 分） */
function nextInterval(input: { 決まった間隔: number; 続けて失敗した回数: number }): number {
  return Math.min(input.決まった間隔 * 2 ** input.続けて失敗した回数, 30);
}

/** 一度に大量に消えたか（10 件以上で、あった件数の 5 割以上が一度に消えた） */
function massRemoval(input: { あった件数: number; 消えた件数: number }): "ふつう" | "一度に大量に消えた" {
  return input.消えた件数 >= 10 && input.消えた件数 * 2 >= input.あった件数 ? "一度に大量に消えた" : "ふつう";
}

/** 取り込めないことを知らせるか */
function notifyFailure(input: { 続けて失敗した回数: number; 理由: SyncError | "トークンが通らない" }): "知らせる" | "知らせない" {
  if (input.理由 === "トークンが通らない") return "知らせる";
  return input.続けて失敗した回数 >= 3 ? "知らせる" : "知らせない";
}

export const decisions = {
  次に取りに行くまで: {
    decide: nextInterval,
    cases: [
      { input: { 決まった間隔: 1, 続けて失敗した回数: 0 }, expect: 1 },
      { input: { 決まった間隔: 1, 続けて失敗した回数: 3 }, expect: 8 },
      { input: { 決まった間隔: 5, 続けて失敗した回数: 4 }, expect: 30 },
    ],
  },
  一度に大量に消えたか: {
    decide: massRemoval,
    cases: [
      { input: { あった件数: 100, 消えた件数: 3 }, expect: "ふつう" },
      { input: { あった件数: 12, 消えた件数: 9 }, expect: "ふつう" },
      { input: { あった件数: 100, 消えた件数: 60 }, expect: "一度に大量に消えた" },
      { input: { あった件数: 20, 消えた件数: 20 }, expect: "一度に大量に消えた" },
      { input: { あった件数: 100, 消えた件数: 30 }, expect: "ふつう" },
    ],
  },
  取り込めないことを知らせるか: {
    decide: notifyFailure,
    cases: [
      { input: { 続けて失敗した回数: 1, 理由: "ネットワーク" }, expect: "知らせない" },
      { input: { 続けて失敗した回数: 3, 理由: "ネットワーク" }, expect: "知らせる" },
      { input: { 続けて失敗した回数: 1, 理由: "トークンが通らない" }, expect: "知らせる" },
    ],
  },
};

export const scenarios = {
  "一度に大量に消えたら、反映を止めてユーザーに確かめる": [
    { do: initial, by: "アプリ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: succeed, by: "Source", input: "大量に消えた", expect: { status: "確かめている", cursor: null } },
    { do: start, by: "アプリ", input: "時刻を過ぎた", denied: "待っているときだけ" },
    { do: confirmRemoval, by: "Source", denied: "ユーザーだけ" },
    { do: rejectRemoval, by: "アプリ", denied: "ユーザーだけ" },
    { do: rejectRemoval, by: "ユーザー", expect: { status: "待っている", lastError: "想定外の応答" } },
    { do: rejectRemoval, by: "ユーザー", denied: "確かめているときだけ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: succeed, by: "Source", input: "大量に消えた" },
    { do: confirmRemoval, by: "ユーザー", expect: { status: "待っている", lastError: null } },
    { do: confirmRemoval, by: "ユーザー", denied: "確かめているときだけ" },
  ],
  "時刻が来たら取り込み、カーソルを進める": [
    { do: initial, by: "アプリ", expect: { status: "待っている", cursor: null } },
    { do: start, by: "アプリ", input: "まだ", denied: "次に取りに行く時刻を過ぎたときだけ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた", expect: { status: "取り込んでいる" } },
    { do: start, by: "アプリ", input: "時刻を過ぎた", denied: "待っているときだけ" },
    { do: succeed, by: "Source", input: "ふつう", expect: { status: "待っている", lastError: null } },
  ],
  "回数の上限なら、Source が言った時刻まで待つ": [
    { do: initial, by: "アプリ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: fail, by: "Source", input: "回数の上限", expect: { status: "待っている", lastError: "回数の上限" } },
  ],
  "ネットワークが切れていたら、次の回にやり直す": [
    { do: initial, by: "アプリ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: fail, by: "Source", input: "ネットワーク", expect: { status: "待っている", lastError: "ネットワーク" } },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: succeed, by: "Source", input: "ふつう", expect: { lastError: null } },
  ],
  "カーソルが古すぎたら、初めの取り込みからやり直す": [
    { do: initial, by: "アプリ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: succeed, by: "Source", input: "ふつう" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: resetCursor, by: "Source", expect: { cursor: null } },
  ],
  "トークンが切れたら止め、つなぎ直したら再開する": [
    { do: initial, by: "アプリ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: reject, by: "Source", expect: { status: "止めている", lastError: "トークンが通らない" } },
    { do: start, by: "アプリ", input: "時刻を過ぎた", denied: "待っているときだけ" },
    { do: resume, by: "Source", denied: "アプリだけ" },
    { do: resume, by: "アプリ", expect: { status: "待っている" } },
    { do: resume, by: "アプリ", denied: "止めているときだけ" },
  ],
  "形に合わない応答・途中で切れた全件取得は、取り込めたとは扱わない": [
    { do: initial, by: "アプリ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: fail, by: "Source", input: "想定外の応答", expect: { status: "待っている", lastError: "想定外の応答" } },
  ],
  "取り込んでいる間にアプリが止まったら、起動したときにやり直す": [
    { do: initial, by: "アプリ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: interrupt, by: "Source", denied: "アプリだけ" },
    { do: interrupt, by: "アプリ", expect: { status: "待っている" } },
    { do: interrupt, by: "アプリ", denied: "取り込んでいるときだけ" },
  ],
  "アカウントを外したら、取り込みをやめる": [
    { do: initial, by: "アプリ" },
    { do: end, by: "Source", denied: "アプリだけ" },
    { do: end, by: "アプリ", expect: { status: "やめた" } },
    { do: end, by: "アプリ", denied: "やめていないときだけ" },
    { do: resume, by: "アプリ", denied: "止めているときだけ" },
  ],
  "取り込みを始めるのはアプリだけ": [{ do: initial, by: "Source", denied: "アプリだけ" }],
  "取り込みの結果を返すのは Source だけ": [
    { do: initial, by: "アプリ" },
    { do: start, by: "Source", input: "時刻を過ぎた", denied: "アプリだけ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: succeed, by: "アプリ", input: "ふつう", denied: "Source だけ" },
    { do: fail, by: "アプリ", input: "ネットワーク", denied: "Source だけ" },
    { do: resetCursor, by: "アプリ", denied: "Source だけ" },
    { do: reject, by: "アプリ", denied: "Source だけ" },
    { do: succeed, by: "Source", input: "ふつう" },
    { do: succeed, by: "Source", input: "ふつう", denied: "取り込んでいるときだけ" },
    { do: fail, by: "Source", input: "ネットワーク", denied: "取り込んでいるときだけ" },
    { do: resetCursor, by: "Source", denied: "取り込んでいるときだけ" },
    { do: reject, by: "Source", denied: "取り込んでいるときだけ" },
  ],
};

export const reviewed = {
  "ignores-input:fail": "どの理由でも、カーソルを進めずに次の回にやり直す。理由は記録と知らせ（判断表「取り込めないことを知らせるか」）に使い、待つ時間は判断表「次に取りに行くまで」と、回数の上限なら Source が言った時刻で決まる",
  "unused-field:stream": "見分けるための値で、操作の可否は変えない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
};

