import { ensure } from "@yutaura/live-spec";
import type { ActionDefinition } from "./action-definition.value.ts";

/**
 * 定期の Task の決まり（毎月 1 日に請求書を送る・毎週月曜に週報を書く など。ADR-0011）。
 *
 * 決まりが持つのは 4 つだけ: 使っているか・何を作るか（タイトル・メモ・ひな形の計画・期日）・いつ作るか（決まり方）・最後に作った回。
 * 回は、決まり方から出る予定日で見分ける（毎月 1 日なら 12/1・1/1、毎週月曜なら 12/7・12/14）。決まり方に依らず、「何月分か」のような決まり方ごとの数え方はしない。
 * アプリは 1 時間おきに、「直近の回をまだ作っていなければ作る」だけを確かめる（判断表「今、作るか」）。直近の回は、作る日（予定日から前倒しの日数だけ早めた日）を過ぎた回のうち、いちばん新しいもの。
 * 直近の回を作ったかは保存せず、最後に作った回と直近の回を比べて分かる（保存すると、回が変わるたびに書き換えないと食い違うため）。
 *
 * - 決まり方: 毎日・毎週（曜日）・毎月（日。その月にない日は月末）・毎年（月日）。cron や RRULE の文字列ではなく決まり方ごとの型で持つ（その月にない日は月末・前倒しを表せ、画面ではそのまま「毎月 1 日」と見せられるため）。ほかの決まり方は、必要になったら型を足す
 * - 日付は PC のタイムゾーンで数える
 * - 作る Task: タイトルに回（予定日。毎月なら「12 月分」、毎週なら「12/7 の週」のように決まり方ごとに見せる）を付け、メモを状況に載せ、ひな形の Action Item を計画にし、期日を決めていれば付ける（期日から優先度が決まる）。どの決まりのどの回かを Task が持つ
 * - 同じ回は二度作らない。作った Task を消しても作り直さない。前の回が終わっていなくても作り、状況に書く。止めていた間・アプリを閉じていた間に過ぎた回は、まとめて作らない（直近の回だけ）
 * - 次の回（直近の回の次）をまだ作っていなくて、その作る日が近ければ、Todo のレーンに予告（ゴースト）として見せ、「今すぐ作る」で待たずに作れる（判断表「予告を出すか」）。予告は本当の Task ではないので、動かせない・消せない・決まりの状態も変えない
 * - 決まりを作るのはユーザーだけ。AI（Generation）は Task に下書きを置くだけで、決まりはユーザーが承認してから作る
 */
export type RecurringTask = {
  /** 使っているか */
  status: Status;
  /** 決まりを見分ける ID */
  id: string;
  /** 作る Task のタイトル（回は、作るときに付ける） */
  title: string;
  /** 作る Task の状況に載せるメモ */
  note: string;
  /** 作る Task の計画のひな形（Action Item の中身の並び） */
  template: ActionDefinition[];
  /** いつ作るか（決まり方・何日前倒しして作るか）と、作る Task の期日（予定日から何日後か。決めなければ期日なし） */
  schedule: { rule: Rule; advanceDays: number; dueAfterDays: number | null };
  /** 最後に作った（または見送った）回の予定日（"YYYY-MM-DD"。まだなら null）。同じ回を二度作らないための記録 */
  lastOccurrence: string | null;
};

/** 決まり方（予定日の出し方） */
export type Rule =
  | { type: "毎日" }
  | { type: "毎週"; weekday: "月" | "火" | "水" | "木" | "金" | "土" | "日" }
  /** その月にない日（31 日の 2 月 など）は月末 */
  | { type: "毎月"; day: number }
  | { type: "毎年"; month: number; day: number };

export const Status = {
  /** 作る日が来たら作る */
  active: "使っている",
  /** 作らない・予告も出さない */
  paused: "止めている",
  /** 消した（作った Task は残す） */
  removed: "消した",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "user" } | { kind: "app" };

/** アプリ: 1 時間おきに確かめて、作る */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

/** 判断表「今、作るか」の答え（最後に作った回と直近の回から、アプリが確かめる） */
type Due = "直近の回は作った" | "直近の回をまだ作っていない";

/**
 * 決まりを作る（手で登録する・Task から作る・AI の下書きを承認する）
 *
 * 直近の回の作る日をもう過ぎていたら、その回を作るか見送るかを選ぶ（見送ったら、その回は作ったことにする）。
 */
export function initial(actor: Actor, title: "ある" | "空", latest: "作る" | "見送る"): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ（AI の下書きは、ユーザーが承認してから）");
  ensure(title === "ある", "タイトルが要る");
  return {
    status: "使っている",
    id: "rt1",
    title: "請求書を送る",
    note: "",
    template: [{ title: "請求書を作って送る", effort: "normal", due: null, completes: true, how: { type: "human", place: null } }],
    schedule: { rule: { type: "毎月", day: 1 }, advanceDays: 0, dueAfterDays: 5 },
    lastOccurrence: latest === "見送る" ? "2026-11-01" : null,
  };
}

/** 直近の回をまだ作っていないので、作る（1 時間おきの確かめで） */
export function create(task: RecurringTask, actor: Actor, due: Due): RecurringTask {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(task.status === "使っている", "使っているときだけ");
  ensure(due === "直近の回をまだ作っていない", "直近の回をまだ作っていないときだけ");
  return { ...task, lastOccurrence: "2026-12-01" };
}

/** 予告から「今すぐ作る」（作る日を待たずに、次の回を作る。直近の回をまだ作っていなければ、先にそちらを作る） */
export function createNow(task: RecurringTask, actor: Actor, due: Due): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "使っている", "使っているときだけ");
  ensure(due === "直近の回は作った", "直近の回を作ったあとだけ（作り損ねた回があれば、先にそちらを作る）");
  return { ...task, lastOccurrence: "2027-01-01" };
}

/** 決まりを直す（タイトル・メモ・ひな形・いつ作るか）。直しても、最後に作った回は戻さない */
export function edit(task: RecurringTask, actor: Actor, title: "ある" | "空"): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status !== "消した", "消していないときだけ");
  ensure(title === "ある", "タイトルが要る");
  return { ...task, note: "今回は先方の担当が変わる" };
}

/** 止める（作らない・予告も出さない） */
export function pause(task: RecurringTask, actor: Actor): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "使っている", "使っているときだけ");
  return { ...task, status: "止めている" };
}

/** また使う（止めていた間の回は、まとめて作らない。直近の回の作る日をもう過ぎていたら、登録のときと同じく作るか見送るかを選ぶ） */
export function resume(task: RecurringTask, actor: Actor, latest: "作る" | "見送る"): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "止めている", "止めているときだけ");
  return latest === "見送る" ? { ...task, status: "使っている", lastOccurrence: "2026-12-01" } : { ...task, status: "使っている" };
}

/** 消す（作った Task は残す） */
export function remove(task: RecurringTask, actor: Actor): RecurringTask {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status !== "消した", "消していないときだけ");
  return { ...task, status: "消した" };
}

export const inputs = {
  initial: { 直近の回も作る: ["ある", "作る"], 直近の回は見送る: ["ある", "見送る"], タイトルが空: ["空", "作る"] },
  create: { まだ作っていない: ["直近の回をまだ作っていない"], もう作った: ["直近の回は作った"] },
  createNow: { 直近の回は作った: ["直近の回は作った"], 作り損ねた: ["直近の回をまだ作っていない"] },
  edit: { ある: ["ある"], 空: ["空"] },
  resume: { 直近の回も作る: ["作る"], 直近の回は見送る: ["見送る"] },
};

/** 今、作るか（最後に作った回の予定日と、作る日を過ぎた回のうちいちばん新しい回の予定日を比べる） */
function whetherToCreate(input: { 最後に作った回: string | null; 直近の回: string | null }): Due {
  if (input.直近の回 === null) return "直近の回は作った";
  if (input.最後に作った回 !== null && input.最後に作った回 >= input.直近の回) return "直近の回は作った";
  return "直近の回をまだ作っていない";
}

/**
 * 予告を出すか（次の回の作る日まで、予告を出す日数以内なら出す）
 *
 * 予告を出す日数は、7 日と「回と回の間」の短いほうから 1 日引いたもの（毎週なら前日だけ）。毎日の決まりは、次の回がいつも明日で予告が出っぱなしになるので出さない。
 */
function whetherToPreview(input: { 決まり方: Rule["type"]; 次の回の作る日まで: number; 次の回をもう作った: boolean }): "出す" | "出さない" {
  if (input.決まり方 === "毎日" || input.次の回をもう作った) return "出さない";
  const window = input.決まり方 === "毎週" ? 1 : 7;
  return input.次の回の作る日まで >= 1 && input.次の回の作る日まで <= window ? "出す" : "出さない";
}

export const decisions = {
  予告を出すか: {
    decide: whetherToPreview,
    cases: [
      { input: { 決まり方: "毎月", 次の回の作る日まで: 5, 次の回をもう作った: false }, expect: "出す" },
      { input: { 決まり方: "毎月", 次の回の作る日まで: 10, 次の回をもう作った: false }, expect: "出さない" },
      { input: { 決まり方: "毎月", 次の回の作る日まで: 5, 次の回をもう作った: true }, expect: "出さない" },
      { input: { 決まり方: "毎週", 次の回の作る日まで: 1, 次の回をもう作った: false }, expect: "出す" },
      { input: { 決まり方: "毎週", 次の回の作る日まで: 3, 次の回をもう作った: false }, expect: "出さない" },
      { input: { 決まり方: "毎日", 次の回の作る日まで: 1, 次の回をもう作った: false }, expect: "出さない" },
      { input: { 決まり方: "毎年", 次の回の作る日まで: 7, 次の回をもう作った: false }, expect: "出す" },
    ],
  },
  "今、作るか": {
    decide: whetherToCreate,
    cases: [
      { input: { 最後に作った回: "2026-11-01", 直近の回: "2026-12-01" }, expect: "直近の回をまだ作っていない" },
      { input: { 最後に作った回: "2026-12-01", 直近の回: "2026-12-01" }, expect: "直近の回は作った" },
      { input: { 最後に作った回: null, 直近の回: "2026-12-07" }, expect: "直近の回をまだ作っていない" },
      { input: { 最後に作った回: null, 直近の回: null }, expect: "直近の回は作った" },
      { input: { 最後に作った回: "2027-01-01", 直近の回: "2026-12-01" }, expect: "直近の回は作った" },
      { input: { 最後に作った回: "2026-10-01", 直近の回: "2026-12-01" }, expect: "直近の回をまだ作っていない" },
    ],
  },
};

const validRule = (rule: Rule) =>
  rule.type === "毎日" || rule.type === "毎週" || (rule.type === "毎月" ? rule.day >= 1 && rule.day <= 31 : rule.month >= 1 && rule.month <= 12 && rule.day >= 1 && rule.day <= 31);

export const invariants = {
  "消した決まりは、もう変わらない": (before: RecurringTask, after: RecurringTask) => before.status !== "消した" || after.status === "消した",
  "決まり方の日付は正しく、前倒しと期日は 0 日以上": (task: RecurringTask) =>
    validRule(task.schedule.rule) && task.schedule.advanceDays >= 0 && (task.schedule.dueAfterDays === null || task.schedule.dueAfterDays >= 0),
  "ひな形は期日と版を持たない（毎回同じものを写すので、決まった日付・古い版を持ち込まない。期日は dueAfterDays で付ける）": (task: RecurringTask) =>
    task.template.every((d) => d.due === null && (d.how.type !== "write" || d.how.version === null)),
};

export const links = [
  { from: create, to: "task", label: "決まりから Task を作る（回を付けたタイトル・メモを載せた状況・ひな形の Action Item の計画・期日・どの決まりのどの回か）。前の回が終わっていなければ、状況に書く" },
  { from: createNow, to: "task", label: "決まりから Task を作る（作る日を待たずに。期日は決まりのとおり）" },
];

export const scenarios = {
  "毎月 1 日に、請求書を送る Task を作る": [
    { do: initial, by: "ユーザー", input: "直近の回は見送る", expect: { status: "使っている", lastOccurrence: "2026-11-01" } },
    { do: create, by: "アプリ", input: "もう作った", denied: "直近の回をまだ作っていないときだけ" },
    { do: create, by: "アプリ", input: "まだ作っていない", expect: { lastOccurrence: "2026-12-01" } },
  ],
  "登録したとき、作る日を過ぎた直近の回は、作るか見送るかを選ぶ": [
    { do: initial, by: "ユーザー", input: "直近の回も作る", expect: { lastOccurrence: null } },
    { do: create, by: "アプリ", input: "まだ作っていない", expect: { lastOccurrence: "2026-12-01" } },
  ],
  "予告から今すぐ作る（作り損ねた回があれば、先にそちらを作る）": [
    { do: initial, by: "ユーザー", input: "直近の回も作る" },
    { do: createNow, by: "ユーザー", input: "作り損ねた", denied: "直近の回を作ったあとだけ（作り損ねた回があれば、先にそちらを作る）" },
    { do: create, by: "アプリ", input: "まだ作っていない" },
    { do: createNow, by: "アプリ", input: "直近の回は作った", denied: "ユーザーだけ" },
    { do: createNow, by: "ユーザー", input: "直近の回は作った", expect: { lastOccurrence: "2027-01-01" } },
  ],
  "止めている間は作らず、また使うときは直近の回を作るか見送るかを選ぶ": [
    { do: initial, by: "ユーザー", input: "直近の回は見送る" },
    { do: pause, by: "ユーザー", expect: { status: "止めている" } },
    { do: pause, by: "ユーザー", denied: "使っているときだけ" },
    { do: create, by: "アプリ", input: "まだ作っていない", denied: "使っているときだけ" },
    { do: createNow, by: "ユーザー", input: "直近の回は作った", denied: "使っているときだけ" },
    { do: resume, by: "アプリ", input: "直近の回も作る", denied: "ユーザーだけ" },
    { do: resume, by: "ユーザー", input: "直近の回は見送る", expect: { status: "使っている", lastOccurrence: "2026-12-01" } },
    { do: resume, by: "ユーザー", input: "直近の回も作る", denied: "止めているときだけ" },
  ],
  "決まりを作るのはユーザーだけ（AI は下書きを置くだけ）": [{ do: initial, by: "アプリ", input: "直近の回は見送る", denied: "ユーザーだけ（AI の下書きは、ユーザーが承認してから）" }],
  "タイトルのない決まりは作れない": [{ do: initial, by: "ユーザー", input: "タイトルが空", denied: "タイトルが要る" }],
  "決まりを直す・消す": [
    { do: initial, by: "ユーザー", input: "直近の回は見送る" },
    { do: edit, by: "ユーザー", input: "空", denied: "タイトルが要る" },
    { do: edit, by: "アプリ", input: "ある", denied: "ユーザーだけ" },
    { do: edit, by: "ユーザー", input: "ある" },
    { do: remove, by: "アプリ", denied: "ユーザーだけ" },
    { do: remove, by: "ユーザー", expect: { status: "消した" } },
    { do: remove, by: "ユーザー", denied: "消していないときだけ" },
    { do: edit, by: "ユーザー", input: "ある", denied: "消していないときだけ" },
  ],
  "作るのはアプリだけ": [
    { do: initial, by: "ユーザー", input: "直近の回も作る" },
    { do: create, by: "ユーザー", input: "まだ作っていない", denied: "アプリだけ" },
    { do: pause, by: "アプリ", denied: "ユーザーだけ" },
  ],
};

export const reviewed = {
  "unused-field:schedule": "いつ作るかはユーザーが決める値で、直近の回を作ったかはアプリが判断表「今、作るか」で確かめて入力で渡す。値の範囲を、不変条件で確かめるために読んでいる",
  "ignores-input:resume": "直近の回を作っても見送っても、また使う。見送ったときだけ最後に作った回を進める（例では、その回がもう作った回と同じ日になるので、結果が同じに見える）",
};
