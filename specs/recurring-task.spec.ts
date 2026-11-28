import { ensure } from "@yutaura/live-spec";

/**
 * 定期の Task（決まった時期に、決まった手順つきで作る Task の決まり 1 つ。毎月の月初めに請求書を送る など。ADR-0011）。
 * 時期が来たら、決まりから Task を作る（1 時間おきに確かめる）。タイトルに何月分かを付け、メモを状況（brief）に載せ、次にやることのひな形を計画にする。
 * 日付は PC のタイムゾーンで数え、その月にない日（31 日など）は月末にする。
 * 作る日の何日か前から、まだ作っていない月の分を予告として見せる（本当の Task ではないので、動かせない・消せない）。「今すぐ作る」で、作る日を待たずに作れる。
 * 決まりを作るのはユーザーだけ（手で登録する・Task から作る）。AI が「定期の Task にしませんか」と提案するときも、下書きを作るだけで、決まりを作るのはユーザーが承認してから。
 */
export type RecurringTask = {
  /** 決まりを使っているか */
  status: Status;
  /** 今の月の分を、もう作ったか（同じ月の分は二度作らない。作った Task を消しても作り直さない） */
  period: "今月の分を作った" | "今月の分はまだ";
  /** 決まりを見分ける ID */
  id: string;
  /** 作る Task のタイトル（何月分かは、作るときに付ける） */
  title: string;
  /** 作る Task の状況に載せるメモ（その月だけの注意 など） */
  note: string;
  /** 作る Task に持たせる次にやることのひな形（済んだ印などを外したもの） */
  template: unknown;
  /** いつ作るか（今は毎月 N 日だけ。何日前から予告を出すか） */
  schedule: { type: "毎月"; day: number; previewDays: number };
  /** 最後に Task を作った月（"YYYY-MM"） */
  lastPeriod: string | null;
};

export const Status = {
  /** 時期が来たら作る */
  active: "使っている",
  /** 止めている（作らない・予告も出さない） */
  paused: "止めている",
  /** 消した */
  removed: "消した",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "user" } | { kind: "scheduler" } | { kind: "agent" };

/** 定期の処理: 1 時間おきに時期を確かめる。AI: 定期の Task にする下書きを提案する */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  定期の処理: { kind: "scheduler" },
  AI: { kind: "agent" },
};

/**
 * 決まりを作る（手で登録する・Task から作る・AI の下書きを承認する）
 *
 * 登録した時点で時期を過ぎた今月の分は、明示したときだけ作る。
 */
export function initial(actor: Actor, title: "ある" | "空", current: "今月の分も作る" | "今月の分は作らない"): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ（AI の提案は、ユーザーが承認してから）");
  ensure(title === "ある", "タイトルが要る");
  return {
    status: "使っている",
    period: current === "今月の分も作る" ? "今月の分はまだ" : "今月の分を作った",
    id: "rt1",
    title: "請求書を送る",
    note: "",
    template: null,
    schedule: { type: "毎月", day: 1, previewDays: 7 },
    lastPeriod: current === "今月の分も作る" ? null : "2026-11",
  };
}

/**
 * 時期が来たので、今月の分の Task を作る
 *
 * 前の月の分が終わっていなくても作り、そのことを状況に書く（作らずにおくと、今月の分を忘れるおそれがあるため）。
 */
export function createDue(task: RecurringTask, actor: Actor, timing: "作る日を過ぎた" | "まだ"): RecurringTask {
  ensure(actor.kind === "scheduler", "定期の処理だけ");
  ensure(task.status === "使っている", "使っているときだけ");
  ensure(task.period === "今月の分はまだ", "今月の分をまだ作っていないときだけ");
  ensure(timing === "作る日を過ぎた", "作る日を過ぎたときだけ");
  return { ...task, period: "今月の分を作った", lastPeriod: "2026-12" };
}

/** 予告から「今すぐ作る」（作る日を待たずに、その月の分を作る） */
export function createNow(task: RecurringTask, actor: Actor): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "使っている", "使っているときだけ");
  ensure(task.period === "今月の分はまだ", "今月の分をまだ作っていないときだけ");
  return { ...task, period: "今月の分を作った", lastPeriod: "2026-12" };
}

/** 月が変わった（次の月の分を、まだ作っていないことになる） */
export function monthChanged(task: RecurringTask, actor: Actor): RecurringTask {
  ensure(actor.kind === "scheduler", "定期の処理だけ");
  ensure(task.status !== "消した", "消していないときだけ");
  ensure(task.period === "今月の分を作った", "今月の分を作ったときだけ");
  return { ...task, period: "今月の分はまだ" };
}

/** 決まりを直す（タイトル・メモ・ひな形・いつ作るか） */
export function edit(task: RecurringTask, actor: Actor, title: "ある" | "空"): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status !== "消した", "消していないときだけ");
  ensure(title === "ある", "タイトルが要る");
  return { ...task, note: "今月は先方の担当が変わる" };
}

/** 止める（作らない・予告も出さない） */
export function pause(task: RecurringTask, actor: Actor): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "使っている", "使っているときだけ");
  return { ...task, status: "止めている" };
}

/** また使う（止めていた間の月の分は、まとめて作らない） */
export function resume(task: RecurringTask, actor: Actor): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "止めている", "止めているときだけ");
  return { ...task, status: "使っている" };
}

/** 消す（作った Task は残す） */
export function remove(task: RecurringTask, actor: Actor): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status !== "消した", "消していないときだけ");
  return { ...task, status: "消した" };
}

export const inputs = {
  initial: {
    今月の分も作る: ["ある", "今月の分も作る"],
    今月の分は作らない: ["ある", "今月の分は作らない"],
    タイトルが空: ["空", "今月の分は作らない"],
  },
  createDue: { 過ぎた: ["作る日を過ぎた"], まだ: ["まだ"] },
  edit: { ある: ["ある"], 空: ["空"] },
};

export const invariants = {
  "消した決まりは、もう変わらない": (before: RecurringTask, after: RecurringTask) => before.status !== "消した" || after.status === "消した",
};

export const links = [
  { from: createDue, to: "task", label: "決まりから Task を作る（何月分かを付けたタイトル・メモを載せた状況・ひな形の計画）。前の月の分が終わっていなければ、状況に書く" },
  { from: createNow, to: "task", label: "決まりから Task を作る" },
];

export const scenarios = {
  "毎月 1 日に請求書を送る Task を作る": [
    { do: initial, by: "ユーザー", input: "今月の分は作らない", expect: { status: "使っている", period: "今月の分を作った" } },
    { do: createDue, by: "定期の処理", input: "過ぎた", denied: "今月の分をまだ作っていないときだけ" },
    { do: monthChanged, by: "定期の処理", expect: { period: "今月の分はまだ" } },
    { do: monthChanged, by: "定期の処理", denied: "今月の分を作ったときだけ" },
    { do: createDue, by: "定期の処理", input: "まだ", denied: "作る日を過ぎたときだけ" },
    { do: createDue, by: "定期の処理", input: "過ぎた", expect: { period: "今月の分を作った" } },
    { do: createNow, by: "ユーザー", denied: "今月の分をまだ作っていないときだけ" },
  ],
  "登録した時点で時期を過ぎた今月の分は、明示したときだけ作る": [
    { do: initial, by: "ユーザー", input: "今月の分も作る", expect: { period: "今月の分はまだ" } },
    { do: createDue, by: "定期の処理", input: "過ぎた", expect: { period: "今月の分を作った" } },
  ],
  "予告から今すぐ作る": [
    { do: initial, by: "ユーザー", input: "今月の分は作らない" },
    { do: monthChanged, by: "定期の処理" },
    { do: createNow, by: "AI", denied: "ユーザーだけ" },
    { do: createNow, by: "ユーザー", expect: { period: "今月の分を作った" } },
  ],
  "止めている間は作らない": [
    { do: initial, by: "ユーザー", input: "今月の分は作らない" },
    { do: pause, by: "ユーザー", expect: { status: "止めている" } },
    { do: pause, by: "ユーザー", denied: "使っているときだけ" },
    { do: monthChanged, by: "定期の処理" },
    { do: createDue, by: "定期の処理", input: "過ぎた", denied: "使っているときだけ" },
    { do: createNow, by: "ユーザー", denied: "使っているときだけ" },
    { do: resume, by: "ユーザー", expect: { status: "使っている" } },
    { do: resume, by: "ユーザー", denied: "止めているときだけ" },
  ],
  "決まりを作るのはユーザーだけ（AI は下書きを提案するだけ）": [
    { do: initial, by: "AI", input: "今月の分は作らない", denied: "ユーザーだけ（AI の提案は、ユーザーが承認してから）" },
  ],
  "タイトルのない決まりは作れない": [
    { do: initial, by: "ユーザー", input: "タイトルが空", denied: "タイトルが要る" },
  ],
  "決まりを直す・消す": [
    { do: initial, by: "ユーザー", input: "今月の分は作らない" },
    { do: edit, by: "ユーザー", input: "空", denied: "タイトルが要る" },
    { do: edit, by: "AI", input: "ある", denied: "ユーザーだけ" },
    { do: edit, by: "ユーザー", input: "ある" },
    { do: remove, by: "AI", denied: "ユーザーだけ" },
    { do: remove, by: "ユーザー", expect: { status: "消した" } },
    { do: remove, by: "ユーザー", denied: "消していないときだけ" },
    { do: edit, by: "ユーザー", input: "ある", denied: "消していないときだけ" },
    { do: monthChanged, by: "定期の処理", denied: "消していないときだけ" },
  ],
  "時期を確かめるのは定期の処理だけ": [
    { do: initial, by: "ユーザー", input: "今月の分も作る" },
    { do: createDue, by: "ユーザー", input: "過ぎた", denied: "定期の処理だけ" },
    { do: createDue, by: "定期の処理", input: "過ぎた" },
    { do: monthChanged, by: "ユーザー", denied: "定期の処理だけ" },
    { do: pause, by: "AI", denied: "ユーザーだけ" },
  ],
};

export const questions = [
  {
    ask: "前に「定期の Task は後で考えよう」と決めて Task の spec から外した。この spec は ADR-0011 と今の実装をそのまま書き起こした下書き。今の形で残すか、考え直してから書き直すか？",
    about: initial,
  },
  {
    ask: "止めていた間の月の分は、また使い始めたときに作るか？ 案: 作らない（今の月の分だけ、作る日が来たら作る）",
    about: resume,
  },
  {
    ask: "毎週・月の最初の営業日などの決まり方を足すか？（ADR-0011 は、必要になったら足すとしている）",
    about: initial,
  },
];
