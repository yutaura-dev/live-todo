import { ensure } from "@yutaura/live-spec";

/**
 * 定期の Task（決まった時期に、決まった手順つきで作る Task の決まり 1 つ。毎月の月初めに請求書を送る など。ADR-0011）。
 * 時期が来たら、決まりから Task を作る（1 時間おきに確かめる）。タイトルに何月分かを付け、メモを状況（brief）に載せ、次にやることのひな形を計画にする。
 * 「対象の月」は何月分か（タイトルに付ける月）で、「作る日」は、決めた日（その月にない日は月末）から前倒しの日数だけ早めた日（月初めを前倒しすると、前の月のうちに作る）。日付は PC のタイムゾーンで数える。
 * 作る日の 7 日前から、まだ作っていない対象の月の分を予告として見せる（本当の Task ではないので、動かせない・消せない）。「今すぐ作る」で、作る日を待たずに作れる。
 * 1 つの決まりの同じ対象の月の分は、Task が 1 つまで（定期の処理と「今すぐ作る」が同時に動いても 2 つ作らない）。作った Task は、どの決まりの何月分かを持つ。作った人は定期の処理で、作ったことは Task の変化として残す。
 * 決まりを作るのはユーザーだけ（手で登録する・Task から作る）。AI が「定期の Task にしませんか」と提案するときも、Task に下書きを置くだけで、決まりを作るのはユーザーが承認してから。下書きを作る LLM の応答は決まった形で確かめ、合わなければ提案しない（fail closed）。会社の Task は、会社が許可した LLM Profile だけで下書きを作る。
 */
export type RecurringTask = {
  /** 決まりを使っているか */
  status: Status;
  /** 今の対象の月の分を、もう作ったか（最後に作った月と、今の対象の月を比べて決まる。登録のときに見送った月も「作った」に数える。同じ月の分は二度作らない。作った Task を消しても作り直さない） */
  period: "今月の分を作った" | "今月の分はまだ";
  /** 決まりを見分ける ID */
  id: string;
  /** 作る Task のタイトル（何月分かは、作るときに付ける） */
  title: string;
  /** 作る Task の状況に載せるメモ（その月だけの注意 など） */
  note: string;
  /** 作る Task に持たせる次にやることのひな形（済んだ印などを外したもの） */
  template: unknown;
  /** いつ作るか（今は毎月 N 日だけ。何日前倒しして作るか） */
  schedule: { type: "毎月"; day: number; advanceDays: number };
  /** 最後に Task を作った（見送った）対象の月（"YYYY-MM"） */
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
export function initial(actor: Actor, title: "ある" | "空", current: "作る日を過ぎた今月の分も作る" | "作る日を過ぎた今月の分は見送る" | "まだ作る日の前"): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ（AI の提案は、ユーザーが承認してから）");
  ensure(title === "ある", "タイトルが要る");
  const skip = current === "作る日を過ぎた今月の分は見送る";
  return {
    status: "使っている",
    period: skip ? "今月の分を作った" : "今月の分はまだ",
    id: "rt1",
    title: "請求書を送る",
    note: "",
    template: null,
    schedule: { type: "毎月", day: 1, advanceDays: 0 },
    lastPeriod: skip ? "2026-11" : null,
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

/**
 * 予告から「今すぐ作る」（作る日を待たずに、その月の分を作る）
 *
 * 作る日を過ぎたのに作っていない月があるときはできない（来月の分を先に作ると、最後に作った月が飛んで、今月の分が二度と作られないため）。
 */
export function createNow(task: RecurringTask, actor: Actor, overdue: "作り損ねた月はない" | "作り損ねた月がある"): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "使っている", "使っているときだけ");
  ensure(task.period === "今月の分はまだ", "今月の分をまだ作っていないときだけ");
  ensure(overdue === "作り損ねた月はない", "作る日を過ぎて作っていない月がないときだけ");
  return { ...task, period: "今月の分を作った", lastPeriod: "2026-12" };
}

/** 対象の月が次に移った（時間が経って、次の月の分を、まだ作っていないことになる。だれかの操作ではなく、定期の処理が確かめて気づく） */
export function monthChanged(task: RecurringTask, actor: Actor): RecurringTask {
  ensure(actor.kind === "scheduler", "定期の処理だけ");
  ensure(task.status !== "消した", "消していないときだけ");
  ensure(task.period === "今月の分を作った", "今月の分を作ったときだけ");
  return { ...task, period: "今月の分はまだ" };
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
    今月の分も作る: ["ある", "作る日を過ぎた今月の分も作る"],
    今月の分は作らない: ["ある", "作る日を過ぎた今月の分は見送る"],
    作る日の前: ["ある", "まだ作る日の前"],
    タイトルが空: ["空", "作る日を過ぎた今月の分は見送る"],
  },
  createNow: { 作り損ねていない: ["作り損ねた月はない"], 作り損ねた: ["作り損ねた月がある"] },
  createDue: { 過ぎた: ["作る日を過ぎた"], まだ: ["まだ"] },
  edit: { ある: ["ある"], 空: ["空"] },
};

export const invariants = {
  "消した決まりは、もう変わらない": (before: RecurringTask, after: RecurringTask) => before.status !== "消した" || after.status === "消した",
};

export const links = [
  { from: createDue, to: "task", label: "決まりから Task を作る（何月分かを付けたタイトル・メモを載せた状況・ひな形の計画・どの決まりの何月分か）。前の月の分が終わっていなければ、状況に書く" },
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
    { do: createNow, by: "ユーザー", input: "作り損ねていない", denied: "今月の分をまだ作っていないときだけ" },
  ],
  "登録した時点で時期を過ぎた今月の分は、明示したときだけ作る": [
    { do: initial, by: "ユーザー", input: "今月の分も作る", expect: { period: "今月の分はまだ" } },
    { do: createDue, by: "定期の処理", input: "過ぎた", expect: { period: "今月の分を作った" } },
  ],
  "予告から今すぐ作る": [
    { do: initial, by: "ユーザー", input: "今月の分は作らない" },
    { do: monthChanged, by: "定期の処理" },
    { do: createNow, by: "AI", input: "作り損ねていない", denied: "ユーザーだけ" },
    { do: createNow, by: "ユーザー", input: "作り損ねた", denied: "作る日を過ぎて作っていない月がないときだけ" },
    { do: createNow, by: "ユーザー", input: "作り損ねていない", expect: { period: "今月の分を作った" } },
  ],
  "作る日の前に登録したら、作る日が来たら作る": [
    { do: initial, by: "ユーザー", input: "作る日の前", expect: { period: "今月の分はまだ" } },
    { do: createDue, by: "定期の処理", input: "まだ", denied: "作る日を過ぎたときだけ" },
    { do: createDue, by: "定期の処理", input: "過ぎた", expect: { period: "今月の分を作った" } },
  ],
  "止めている間は作らない": [
    { do: initial, by: "ユーザー", input: "今月の分は作らない" },
    { do: pause, by: "ユーザー", expect: { status: "止めている" } },
    { do: pause, by: "ユーザー", denied: "使っているときだけ" },
    { do: monthChanged, by: "定期の処理" },
    { do: createDue, by: "定期の処理", input: "過ぎた", denied: "使っているときだけ" },
    { do: createNow, by: "ユーザー", input: "作り損ねていない", denied: "使っているときだけ" },
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
    ask: "作る日を過ぎてから「また使う」にすると、今の実装では次の確認で今月の分がすぐ作られる。登録のときは「明示したときだけ作る」なので、扱いがそろっていない。また使うときも「今月の分も作るか」を聞いて、登録とそろえるか？",
    about: resume,
  },
  {
    ask: "消す操作は要るか？ 今の実装には消す操作がなく、止めるだけ。残すなら、消しても作った Task の「どの決まりの何月分か」は残す",
    about: remove,
  },
  {
    ask: "前に「定期の Task は後で考えよう」と決めて Task の spec から外した。この spec は ADR-0011 と今の実装をそのまま書き起こした下書き。今の形で残すか、考え直してから書き直すか？",
    about: initial,
  },
  {
    ask: "毎週・月の最初の営業日などの決まり方を足すか？（ADR-0011 は、必要になったら足すとしている）",
    about: initial,
  },
];
