import { ensure } from "@yutaura/live-spec";

/**
 * Sync（Source の取り込み 1 つ。アカウントごと・取り込む種類ごとに 1 つ）。決まった間隔でカーソルより後の変化を取り込み、Source Item に反映する（ADR-0003）。
 * 差分を返せる Source（Gmail の historyId など）はそれを使い、返せない Source は全件を取って、前回の fingerprint と比べて変化にする（SnapshotDiffer）。どちらも「カーソルより後の変化」にそろえる。
 * 取り込みは読むだけなので、失敗しても次の回にやり直せばよい（二重に取り込んでも、同じ事実はアカウントと uri で 1 つにまとまる）。
 */
export type Sync = {
  /** 取り込みの段階 */
  status: Status;
  /** どのアカウントか */
  accountId: string;
  /** 何を取り込むか（Gmail の受信箱・GitHub の通知・Slack の保存したもの など） */
  stream: string;
  /** どこまで取り込んだか（Source ごとの形。まだ一度も取り込んでいなければ null で、初めの取り込みをする） */
  cursor: unknown;
  /** 次に取りに行く時刻 */
  nextRunAt: string;
  /** 最後に失敗した理由（うまくいったら消す） */
  lastError: "回数の上限" | "ネットワーク" | "Source のエラー" | null;
};

export const Status = {
  /** 次の回を待っている */
  waiting: "待っている",
  /** 取り込んでいる */
  running: "取り込んでいる",
  /** アカウントのつなぎ直しが要るので止めている（つなぎ直したら再開する） */
  paused: "止めている",
  /** アカウントを外したので、もう取り込まない */
  ended: "やめた",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "app" } | { kind: "source" };

/** アプリ: 時刻が来たら取りに行く・アカウントの変化を伝える。Source: 取りに行った結果を返す */
export const actors: Record<string, Actor> = {
  アプリ: { kind: "app" },
  Source: { kind: "source" },
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

/** 取り込めた（カーソルを進め、次の回は決まった間隔のあと） */
export function succeed(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "source", "Source だけ");
  ensure(sync.status === "取り込んでいる", "取り込んでいるときだけ");
  return { ...sync, status: "待っている", cursor: { historyId: "12345" }, nextRunAt: "2026-11-28T00:01:00Z", lastError: null };
}

/**
 * 取り込めなかった（回数の上限・ネットワーク・Source のエラー）
 *
 * カーソルは進めない。回数の上限なら、Source が言った時刻まで待つ。それ以外は、決まった間隔のあとにやり直す。
 */
export function fail(sync: Sync, actor: Actor, error: "回数の上限" | "ネットワーク" | "Source のエラー"): Sync {
  ensure(actor.kind === "source", "Source だけ");
  ensure(sync.status === "取り込んでいる", "取り込んでいるときだけ");
  return { ...sync, status: "待っている", nextRunAt: error === "回数の上限" ? "2026-11-28T00:15:00Z" : "2026-11-28T00:01:00Z", lastError: error };
}

/**
 * カーソルが古すぎて使えない（Gmail の historyId が期限切れ など）
 *
 * カーソルを捨て、初めの取り込みからやり直す（取りこぼさないため）。
 */
export function resetCursor(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "source", "Source だけ");
  ensure(sync.status === "取り込んでいる", "取り込んでいるときだけ");
  return { ...sync, status: "待っている", cursor: null, nextRunAt: NOW };
}

/** トークンが通らなかった（アカウントを、つなぎ直しが要るにする。Account の spec は別の PR） */
export function reject(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "source", "Source だけ");
  ensure(sync.status === "取り込んでいる", "取り込んでいるときだけ");
  return { ...sync, status: "止めている" };
}

/** アカウントをつなぎ直したので、再開する（すぐ取りに行く） */
export function resume(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(sync.status === "止めている", "止めているときだけ");
  return { ...sync, status: "待っている", nextRunAt: NOW };
}

/** アカウントを外したので、取り込みをやめる */
export function end(sync: Sync, actor: Actor): Sync {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(sync.status !== "やめた", "やめていないときだけ");
  return { ...sync, status: "やめた" };
}

export const inputs = {
  start: { 時刻を過ぎた: ["時刻を過ぎた"], まだ: ["まだ"] },
  fail: { 回数の上限: ["回数の上限"], ネットワーク: ["ネットワーク"], "Source のエラー": ["Source のエラー"] },
};

export const invariants = {
  "やめた取り込みは、もう変わらない": (before: Sync, after: Sync) => before.status !== "やめた" || after.status === "やめた",
};

export const links = [
  { from: succeed, to: "source-item", label: "カーソルより後の変化を、Source Item に反映する（取り込む・変わる・消える・また現れる）" },
];

export const scenarios = {
  "時刻が来たら取り込み、カーソルを進める": [
    { do: initial, by: "アプリ", expect: { status: "待っている", cursor: null } },
    { do: start, by: "アプリ", input: "まだ", denied: "次に取りに行く時刻を過ぎたときだけ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた", expect: { status: "取り込んでいる" } },
    { do: start, by: "アプリ", input: "時刻を過ぎた", denied: "待っているときだけ" },
    { do: succeed, by: "Source", expect: { status: "待っている", lastError: null } },
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
    { do: succeed, by: "Source", expect: { lastError: null } },
  ],
  "カーソルが古すぎたら、初めの取り込みからやり直す": [
    { do: initial, by: "アプリ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: succeed, by: "Source" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: resetCursor, by: "Source", expect: { cursor: null } },
  ],
  "トークンが切れたら止め、つなぎ直したら再開する": [
    { do: initial, by: "アプリ" },
    { do: start, by: "アプリ", input: "時刻を過ぎた" },
    { do: reject, by: "Source", expect: { status: "止めている" } },
    { do: start, by: "アプリ", input: "時刻を過ぎた", denied: "待っているときだけ" },
    { do: resume, by: "Source", denied: "アプリだけ" },
    { do: resume, by: "アプリ", expect: { status: "待っている" } },
    { do: resume, by: "アプリ", denied: "止めているときだけ" },
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
    { do: succeed, by: "アプリ", denied: "Source だけ" },
    { do: fail, by: "アプリ", input: "ネットワーク", denied: "Source だけ" },
    { do: resetCursor, by: "アプリ", denied: "Source だけ" },
    { do: reject, by: "アプリ", denied: "Source だけ" },
    { do: succeed, by: "Source" },
    { do: succeed, by: "Source", denied: "取り込んでいるときだけ" },
    { do: fail, by: "Source", input: "ネットワーク", denied: "取り込んでいるときだけ" },
    { do: resetCursor, by: "Source", denied: "取り込んでいるときだけ" },
    { do: reject, by: "Source", denied: "取り込んでいるときだけ" },
  ],
};

export const questions = [
  {
    ask: "初めの取り込み（つないだとき・カーソルを捨てたとき）は、どこまで遡るか？ 案: 開いているもの（未読・開いている PR・保存したもの）だけを取り、過去のものはまとめて取り込まない",
    about: initial,
  },
  {
    ask: "取り込む間隔は Source ごとに決まった値（今は 1 分など）でよいか？ 失敗が続いたら間隔を延ばすか？（今の実装は、回数の上限のときだけ待つ）",
    about: fail,
  },
];
