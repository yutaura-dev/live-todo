import { ensure } from "@yutaura/live-spec";
import type { ActionDefinition } from "./action-definition.value.ts";

/**
 * 定期の Task（決まった時期に、決まった手順つきで作る Task の決まり 1 つ。毎月の月初めに請求書を送る など。ADR-0011）。
 * 時期が来たら、決まりから Task を作る（1 時間おきに確かめる）。タイトルに何月分かを付け、メモを状況（brief）に載せ、ひな形の Action Item を計画にし、期日を決めていれば期日を付ける（期日から優先度が決まる）。
 * 「回」は何回目の分か（タイトルに付ける。毎月なら「12 月分」）。今の決まり方は毎月だけで、「作る日」は、決めた日（その月にない日は月末）から前倒しの日数だけ早めた日（月初めを前倒しすると、前の月のうちに作る）。日付は PC のタイムゾーンで数える。状態の名前は回で持ち、毎週などを足しても変えずに済むようにする。
 * 作る日の 7 日前から、まだ作っていない対象の月の分を予告として見せる（本当の Task ではないので、動かせない・消せない）。「今すぐ作る」で、作る日を待たずに作れる。
 * 1 つの決まりの同じ回の分は、Task が 1 つまで（定期の処理と「今すぐ作る」が同時に動いても 2 つ作らない）。作った Task は、どの決まりの何回目の分かを持つ（Task の recurrence）。作った人は定期の処理（Task から見るとアプリ）で、作ったことは Task の出来事として残す。
 * 決まりを作るのはユーザーだけ（手で登録する・Task から作る）。AI が「定期の Task にしませんか」と提案するときも、Task に下書きを置くだけで、決まりを作るのはユーザーが承認してから。下書きは Generation が書き（ADR-0022）、応答は決まった形で確かめ、合わなければ提案しない（fail closed）。
 * 毎週・月の最初の営業日などの決まり方は、必要になったら足す（ADR-0011）。
 */
export type RecurringTask = {
  /** 決まりを使っているか */
  status: Status;
  /** 今の対象の月の分を、もう作ったか（最後に作った月と、今の対象の月を比べて決まる。登録のときに見送った月も「作った」に数える。同じ月の分は二度作らない。作った Task を消しても作り直さない） */
  period: "今回の分を作った" | "今回の分はまだ";
  /** 決まりを見分ける ID */
  id: string;
  /** 作る Task のタイトル（何月分かは、作るときに付ける） */
  title: string;
  /** 作る Task の状況に載せるメモ（その月だけの注意 など） */
  note: string;
  /** 作る Task の計画のひな形（Action Item の中身の並び。済んだ印などは持たない） */
  template: ActionDefinition[];
  /** いつ作るか（今は毎月 N 日だけ。何日前倒しして作るか）と、作る Task の期日（決めた日から何日後か。決めなければ期日なし） */
  schedule: { type: "毎月"; day: number; advanceDays: number; dueAfterDays: number | null };
  /** 最後に Task を作った（見送った）回を見分ける値（毎月なら "2026-12"。毎週を足したら "2026-W49" のように決まり方ごとの形） */
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

type Actor = { kind: "user" } | { kind: "scheduler" } | { kind: "generation" };

/** 定期の処理: 1 時間おきに時期を確かめる。Generation: 定期の Task にする下書きを提案する */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  定期の処理: { kind: "scheduler" },
  Generation: { kind: "generation" },
};

/**
 * 決まりを作る（手で登録する・Task から作る・AI の下書きを承認する）
 *
 * 登録した時点で時期を過ぎた今回の分は、明示したときだけ作る。
 */
export function initial(actor: Actor, title: "ある" | "空", current: "作る日を過ぎた今回の分も作る" | "作る日を過ぎた今回の分は見送る" | "まだ作る日の前"): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ（AI の提案は、ユーザーが承認してから）");
  ensure(title === "ある", "タイトルが要る");
  const skip = current === "作る日を過ぎた今回の分は見送る";
  return {
    status: "使っている",
    period: skip ? "今回の分を作った" : "今回の分はまだ",
    id: "rt1",
    title: "請求書を送る",
    note: "",
    template: [{ title: "請求書を作って送る", effort: "normal", due: null, completes: true, how: { type: "human", place: null } }],
    schedule: { type: "毎月", day: 1, advanceDays: 0, dueAfterDays: 5 },
    lastPeriod: skip ? "2026-11" : null,
  };
}

/**
 * 時期が来たので、今回の分の Task を作る
 *
 * 前の月の分が終わっていなくても作り、そのことを状況に書く（作らずにおくと、今回の分を忘れるおそれがあるため）。
 */
export function createDue(task: RecurringTask, actor: Actor, timing: "作る日を過ぎた" | "まだ"): RecurringTask {
  ensure(actor.kind === "scheduler", "定期の処理だけ");
  ensure(task.status === "使っている", "使っているときだけ");
  ensure(task.period === "今回の分はまだ", "今回の分をまだ作っていないときだけ");
  ensure(timing === "作る日を過ぎた", "作る日を過ぎたときだけ");
  return { ...task, period: "今回の分を作った", lastPeriod: "2026-12" };
}

/**
 * 予告から「今すぐ作る」（作る日を待たずに、その月の分を作る）
 *
 * 作る日を過ぎたのに作っていない回があるときはできない（来月の分を先に作ると、最後に作った月が飛んで、今回の分が二度と作られないため）。
 */
export function createNow(task: RecurringTask, actor: Actor, overdue: "作り損ねた回はない" | "作り損ねた回がある"): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "使っている", "使っているときだけ");
  ensure(task.period === "今回の分はまだ", "今回の分をまだ作っていないときだけ");
  ensure(overdue === "作り損ねた回はない", "作る日を過ぎて作っていない回がないときだけ");
  return { ...task, period: "今回の分を作った", lastPeriod: "2026-12" };
}

/** 次の回に移った（時間が経って、次の回の分を、まだ作っていないことになる。だれかの操作ではなく、定期の処理が確かめて気づく） */
export function nextPeriod(task: RecurringTask, actor: Actor): RecurringTask {
  ensure(actor.kind === "scheduler", "定期の処理だけ");
  ensure(task.status !== "消した", "消していないときだけ");
  ensure(task.period === "今回の分を作った", "今回の分を作ったときだけ");
  return { ...task, period: "今回の分はまだ" };
}

/** 決まりを直す（タイトル・メモ・ひな形・いつ作るか）。直しても、最後に作った月は戻さない（作った月の分を作り直さない）。前倒しの日数を増やすと、次の確認で次の月の分を作ることがある */
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

/** また使う（止めていた間の月の分は、まとめて作らない。登録のときと同じく、作る日を過ぎた今回の分は明示したときだけ作る） */
export function resume(task: RecurringTask, actor: Actor, current: "作る日を過ぎた今回の分も作る" | "作る日を過ぎた今回の分は見送る" | "まだ作る日の前"): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "止めている", "止めているときだけ");
  if (current === "作る日を過ぎた今回の分は見送る") return { ...task, status: "使っている", period: "今回の分を作った", lastPeriod: "2026-12" };
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
    今回の分も作る: ["ある", "作る日を過ぎた今回の分も作る"],
    今回の分は作らない: ["ある", "作る日を過ぎた今回の分は見送る"],
    作る日の前: ["ある", "まだ作る日の前"],
    タイトルが空: ["空", "作る日を過ぎた今回の分は見送る"],
  },
  createNow: { 作り損ねていない: ["作り損ねた回はない"], 作り損ねた: ["作り損ねた回がある"] },
  createDue: { 過ぎた: ["作る日を過ぎた"], まだ: ["まだ"] },
  edit: { ある: ["ある"], 空: ["空"] },
  resume: { 今回の分も作る: ["作る日を過ぎた今回の分も作る"], 今回の分は見送る: ["作る日を過ぎた今回の分は見送る"], 作る日の前: ["まだ作る日の前"] },
};

export const invariants = {
  "まだ一度も作っていない（見送ってもいない）なら、今回の分はまだ": (task: RecurringTask) => task.lastPeriod !== null || task.period === "今回の分はまだ",
  "いつ作るかは、決めた日が 1〜31 日、前倒しが 0〜27 日、期日が 0 日以上": (task: RecurringTask) =>
    task.schedule.day >= 1 && task.schedule.day <= 31 && task.schedule.advanceDays >= 0 && task.schedule.advanceDays < 28 && (task.schedule.dueAfterDays === null || task.schedule.dueAfterDays >= 0),
  "ひな形は期日と版を持たない（毎回同じものを写すので、決まった日付・古い版を持ち込まない。期日は dueAfterDays で付ける）": (task: RecurringTask) =>
    task.template.every((d) => d.due === null && (d.how.type !== "write" || d.how.version === null)),
  "消した決まりは、もう変わらない": (before: RecurringTask, after: RecurringTask) => before.status !== "消した" || after.status === "消した",
};

export const links = [
  { from: createDue, to: "task", label: "決まりから Task を作る（何回目の分かを付けたタイトル・メモを載せた状況・ひな形の Action Item の計画・期日・どの決まりの何回目の分か）。前の月の分が終わっていなければ、状況に書く" },
  { from: createNow, to: "task", label: "決まりから Task を作る（作る日を待たずに。期日は決まりのとおり）" },
];

export const scenarios = {
  "毎月 1 日に請求書を送る Task を作る": [
    { do: initial, by: "ユーザー", input: "今回の分は作らない", expect: { status: "使っている", period: "今回の分を作った" } },
    { do: createDue, by: "定期の処理", input: "過ぎた", denied: "今回の分をまだ作っていないときだけ" },
    { do: nextPeriod, by: "定期の処理", expect: { period: "今回の分はまだ" } },
    { do: nextPeriod, by: "定期の処理", denied: "今回の分を作ったときだけ" },
    { do: createDue, by: "定期の処理", input: "まだ", denied: "作る日を過ぎたときだけ" },
    { do: createDue, by: "定期の処理", input: "過ぎた", expect: { period: "今回の分を作った" } },
    { do: createNow, by: "ユーザー", input: "作り損ねていない", denied: "今回の分をまだ作っていないときだけ" },
  ],
  "登録した時点で時期を過ぎた今回の分は、明示したときだけ作る": [
    { do: initial, by: "ユーザー", input: "今回の分も作る", expect: { period: "今回の分はまだ" } },
    { do: createDue, by: "定期の処理", input: "過ぎた", expect: { period: "今回の分を作った" } },
  ],
  "予告から今すぐ作る": [
    { do: initial, by: "ユーザー", input: "今回の分は作らない" },
    { do: nextPeriod, by: "定期の処理" },
    { do: createNow, by: "Generation", input: "作り損ねていない", denied: "ユーザーだけ" },
    { do: createNow, by: "ユーザー", input: "作り損ねた", denied: "作る日を過ぎて作っていない回がないときだけ" },
    { do: createNow, by: "ユーザー", input: "作り損ねていない", expect: { period: "今回の分を作った" } },
  ],
  "作る日の前に登録したら、作る日が来たら作る": [
    { do: initial, by: "ユーザー", input: "作る日の前", expect: { period: "今回の分はまだ" } },
    { do: createDue, by: "定期の処理", input: "まだ", denied: "作る日を過ぎたときだけ" },
    { do: createDue, by: "定期の処理", input: "過ぎた", expect: { period: "今回の分を作った" } },
  ],
  "止めていた決まりをまた使うとき、作る日を過ぎた今回の分は明示したときだけ作る": [
    { do: initial, by: "ユーザー", input: "今回の分は作らない" },
    { do: pause, by: "ユーザー" },
    { do: nextPeriod, by: "定期の処理" },
    { do: resume, by: "ユーザー", input: "今回の分も作る", expect: { status: "使っている", period: "今回の分はまだ" } },
    { do: createDue, by: "定期の処理", input: "過ぎた", expect: { period: "今回の分を作った" } },
  ],
  "止めている間は作らない": [
    { do: initial, by: "ユーザー", input: "今回の分は作らない" },
    { do: pause, by: "ユーザー", expect: { status: "止めている" } },
    { do: pause, by: "ユーザー", denied: "使っているときだけ" },
    { do: nextPeriod, by: "定期の処理" },
    { do: createDue, by: "定期の処理", input: "過ぎた", denied: "使っているときだけ" },
    { do: createNow, by: "ユーザー", input: "作り損ねていない", denied: "使っているときだけ" },
    { do: resume, by: "ユーザー", input: "今回の分は見送る", expect: { status: "使っている", period: "今回の分を作った" } },
    { do: resume, by: "ユーザー", input: "今回の分も作る", denied: "止めているときだけ" },
  ],
  "決まりを作るのはユーザーだけ（AI は下書きを提案するだけ）": [
    { do: initial, by: "Generation", input: "今回の分は作らない", denied: "ユーザーだけ（AI の提案は、ユーザーが承認してから）" },
  ],
  "タイトルのない決まりは作れない": [
    { do: initial, by: "ユーザー", input: "タイトルが空", denied: "タイトルが要る" },
  ],
  "決まりを直す・消す": [
    { do: initial, by: "ユーザー", input: "今回の分は作らない" },
    { do: edit, by: "ユーザー", input: "空", denied: "タイトルが要る" },
    { do: edit, by: "Generation", input: "ある", denied: "ユーザーだけ" },
    { do: edit, by: "ユーザー", input: "ある" },
    { do: remove, by: "Generation", denied: "ユーザーだけ" },
    { do: remove, by: "ユーザー", expect: { status: "消した" } },
    { do: remove, by: "ユーザー", denied: "消していないときだけ" },
    { do: edit, by: "ユーザー", input: "ある", denied: "消していないときだけ" },
    { do: nextPeriod, by: "定期の処理", denied: "消していないときだけ" },
  ],
  "時期を確かめるのは定期の処理だけ": [
    { do: initial, by: "ユーザー", input: "今回の分も作る" },
    { do: createDue, by: "ユーザー", input: "過ぎた", denied: "定期の処理だけ" },
    { do: createDue, by: "定期の処理", input: "過ぎた" },
    { do: nextPeriod, by: "ユーザー", denied: "定期の処理だけ" },
    { do: pause, by: "Generation", denied: "ユーザーだけ" },
    { do: pause, by: "ユーザー" },
    { do: resume, by: "定期の処理", input: "今回の分も作る", denied: "ユーザーだけ" },
  ],
};


export const reviewed = {
  "unused-field:lastPeriod": "最後に作った回は、二度作らないための記録で、可否は今回の分を作ったか（period）で決まる。period とそろっていることを、不変条件で確かめるために読んでいる",
  "unused-field:schedule": "いつ作るかはユーザーが決める値で、作る日が来たかは定期の処理が確かめて入力で渡す。値の範囲を、不変条件で確かめるために読んでいる",
  "indistinguishable-example:resume:今回の分も作る,作る日の前": "どちらも今回の分はまだ作っていないことになり、作る日が来ていれば次の確認で作る（作る日の前なら、作る日が来たら作る）。見送ったときだけ、今回の分を作ったことにする",
};
