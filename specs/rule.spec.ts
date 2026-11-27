import { ensure } from "@yutaura/live-spec";

/**
 * Rule（ルール 1 つ）。「どういう時（きっかけ）」に「何をする」かを決めたもの。
 * ルールを決めたことを、そのルールの範囲の書き込みの承認とみなす（charter・ADR-0014）。アプリが初めから持つ組み込みのルールは、初めは止めてあり、ユーザーが有効にしたことを決めたとみなす。
 * 当てた記録（Rule Run）は、ルールの中に持つ。
 */
export type Rule = {
  /** 当てるか */
  status: Status;
  /** だれが作ったか。組み込みのルールは、ユーザーが有効にする・止めるだけができる（書き換えも消すこともできない） */
  origin: Origin;
  /** Rule を見分ける ID */
  id: string;
  /** 名前（設定の画面に出す） */
  name: string;
  /** どういう時に当てるか */
  trigger: Trigger;
  /** 何をする（言葉で書く。ユーザーのルールは、保存するときに Decisions でアプリの操作に読み取る） */
  then: string;
  /** then から読み取ったアプリの操作。当てるときはこれを使い、文を読み直さない */
  actions: RuleActions;
  /** 有効にした時刻（止めてあれば null）。これより前に起きたことには当てない（まとめて書き込まない） */
  enabledAt: string | null;
};

export const Status = {
  /** 当てる */
  enabled: "有効",
  /** 当てない（組み込みのルールは、初めはこれ） */
  disabled: "止めてある",
  /** ユーザーが消した */
  removed: "消した",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const Origin = {
  user: "ユーザー",
  builtin: "組み込み",
} as const;
export type Origin = (typeof Origin)[keyof typeof Origin];

/**
 * どういう時に当てるか。組み込みのルールかユーザーのルールかとは関係なく、どちらも使える
 * - 判定する: 言葉で書いた条件に当てはまるかを、Task ができた・事実が増えた・事実が変わったときに、Decisions で判定する。確率が 0.8 以上のときだけ当てる
 * - 出来事: アプリが判定する、決まった出来事（Task を完了にした など）。Decisions は呼ばない
 */
export type Trigger =
  | {
      type: "判定する";
      /** どういう時（言葉で書く） */
      when: string;
      /** when を分けた問い（「YutaUra 以外が作った PR か」など）。当てるときは文を読み直さずに、これで判定する */
      clauses: string[];
    }
  | { type: "出来事"; event: RuleEvent };

/** アプリが判定する出来事 */
export type RuleEvent = "Task を完了にした" | "Task を対象外にした";

/** ルールでできる操作。外への書き込みは、ルールの範囲の操作（今は Gmail のラベル・既読・アーカイブ）だけ。送る・消す・merge するなどはルールではできない。「〜なら」のような条件は、何をするの文に混ぜず、どういう時に書く */
export type RuleActions = {
  /** Task をどうするか（変えなければ null） */
  task: "完了にする" | "対象外にする" | "やることにする" | null;
  /** Task が持つ事実への書き込み（provider が決めた操作の名前と中身） */
  writes: { operation: string; params: unknown }[];
};

/** 「何をする」を読み取った結果 */
type Interpretation = "読み取れた" | "はっきりしない" | "できない操作を含む" | "条件が混ざっている" | "答えが返らない";

/** ルールで書き込める操作（ADR-0014） */
const RULE_OPERATIONS = ["gmail.label", "gmail.mark_read", "gmail.archive"];

type Actor = { kind: "user" } | { kind: "app" };

/** アプリ: 組み込みのルールを用意する */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

const ARCHIVE_ON_DONE: Pick<Rule, "name" | "trigger" | "then" | "actions"> = {
  name: "完了にした Task のメールをアーカイブする",
  trigger: { type: "出来事", event: "Task を完了にした" },
  then: "その Task のスレッドの、受け取り済みのメールをアーカイブする",
  actions: { task: null, writes: [{ operation: "gmail.archive", params: { scope: "受け取り済み" } }] },
};

/**
 * ルールを作る
 *
 * ユーザーのルールは、保存するときに「何をする」を読み取り、読み取れたときだけ保存できる（読み取れなければ、直してもらう）。作ったら有効になる（ユーザーが決めたので）。
 * 組み込みのルールは、アプリが用意する。中身はアプリが決めてあるので読み取らない。初めは止めてある。
 */
export function initial(actor: Actor, origin: Origin, interpretation: Interpretation): Rule {
  ensure(origin === "ユーザー" ? actor.kind === "user" : actor.kind === "app", "ユーザーのルールはユーザー、組み込みのルールはアプリだけ");
  if (origin === "ユーザー") ensure(interpretation === "読み取れた", "何をするかを読み取れたときだけ（はっきりしない・ルールではできない操作を含む・条件が混ざっている・答えが返らないなら、直してもらう）");
  return origin === "ユーザー"
    ? {
        status: "有効",
        origin,
        id: "r1",
        name: "請求書のメールを片付ける",
        trigger: { type: "判定する", when: "請求書や領収書に関するメール", clauses: ["請求書や領収書に関するものか"] },
        then: "レシートのラベルを付けて既読にし、Task を完了にする",
        actions: { task: "完了にする", writes: [{ operation: "gmail.label", params: { label: "レシート" } }, { operation: "gmail.mark_read", params: {} }] },
        enabledAt: "2026-11-28T00:00:00Z",
      }
    : { status: "止めてある", origin, id: "builtin.archive-on-done", ...ARCHIVE_ON_DONE, enabledAt: null };
}

/** 有効にする（有効にした時刻より後に起きたことにだけ当てる） */
export function enable(rule: Rule, actor: Actor): Rule {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(rule.status === "止めてある", "止めてあるときだけ");
  return { ...rule, status: "有効", enabledAt: "2026-11-28T00:00:00Z" };
}

/** 止める */
export function disable(rule: Rule, actor: Actor): Rule {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(rule.status === "有効", "有効なときだけ");
  return { ...rule, status: "止めてある", enabledAt: null };
}

/**
 * 書き換える
 *
 * 保存するときに読み取り直し、読み取れたときだけ保存できる。有効なまま書き換えたら、有効にした時刻を今にする（書き換えた中身を、前に起きたことにまとめて当てない。ADR-0014）。
 */
export function edit(rule: Rule, actor: Actor, interpretation: Interpretation): Rule {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(rule.origin === "ユーザー", "ユーザーのルールだけ（組み込みのルールは書き換えられない）");
  ensure(rule.status !== "消した", "消していないときだけ");
  ensure(interpretation === "読み取れた", "何をするかを読み取れたときだけ（はっきりしない・ルールではできない操作を含む・条件が混ざっている・答えが返らないなら、直してもらう）");
  return { ...rule, then: "レシートのラベルを付けて既読にし、Task を完了にする（書き換えた文）", enabledAt: rule.status === "有効" ? "2026-11-28T00:00:00Z" : null };
}

/**
 * アプリを更新して、組み込みのルールの中身が変わった
 *
 * ユーザーが有効にしたのは前の中身なので、止めてある状態に戻す（新しい中身で、有効にし直してもらう）。
 */
export function builtinChanged(rule: Rule, actor: Actor): Rule {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(rule.origin === "組み込み", "組み込みのルールだけ");
  ensure(rule.status === "有効", "有効なときだけ");
  return { ...rule, status: "止めてある", enabledAt: null };
}

/** 消す */
export function remove(rule: Rule, actor: Actor): Rule {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(rule.origin === "ユーザー", "ユーザーのルールだけ（組み込みのルールは消せない。止める）");
  ensure(rule.status !== "消した", "消していないときだけ");
  return { ...rule, status: "消した", enabledAt: null };
}

export const inputs = {
  initial: {
    ユーザーのルール: ["ユーザー", "読み取れた"],
    組み込みのルール: ["組み込み", "読み取れた"],
    はっきりしない: ["ユーザー", "はっきりしない"],
    できない操作: ["ユーザー", "できない操作を含む"],
    答えが返らない: ["ユーザー", "答えが返らない"],
    条件が混ざっている: ["ユーザー", "条件が混ざっている"],
  },
  edit: { 読み取れた: ["読み取れた"], はっきりしない: ["はっきりしない"], できない操作: ["できない操作を含む"], 条件が混ざっている: ["条件が混ざっている"], 答えが返らない: ["答えが返らない"] },
};

export const invariants = {
  "有効なときだけ、有効にした時刻がある": (rule: Rule) => (rule.status === "有効") === (rule.enabledAt !== null),
  "ルールで書き込めるのは、ルールの範囲の操作（Gmail のラベル・既読・アーカイブ）だけ": (rule: Rule) => rule.actions.writes.every((w) => RULE_OPERATIONS.includes(w.operation)),
  "だれが作ったかは、作ったあと変わらない": (before: Rule, after: Rule) => before.origin === after.origin,
  "消したルールは、もう変わらない": (before: Rule, after: Rule) => before.status !== "消した" || after.status === "消した",
};

export const links = [
  { from: enable, to: "rule-run", label: "有効にした時刻より後に起きたきっかけから、当て始める" },
  { from: edit, to: "rule-run", action: "cancel", label: "前の中身で判定を待っている記録は、当てない（書き換えた）" },
  { from: disable, to: "rule-run", action: "cancel", label: "判定を待っている記録は、当てない（止めた）" },
  { from: remove, to: "rule-run", action: "cancel", label: "判定を待っている記録は、当てない（消した）" },
  { from: builtinChanged, to: "rule-run", action: "cancel", label: "判定を待っている記録は、当てない（組み込みのルールの中身が変わった）" },
];

export const scenarios = {
  "ルールを作って当て、止めて、また有効にする": [
    { do: initial, by: "ユーザー", input: "ユーザーのルール", expect: { status: "有効", origin: "ユーザー" } },
    { do: enable, by: "ユーザー", denied: "止めてあるときだけ" },
    { do: disable, by: "ユーザー", expect: { status: "止めてある", enabledAt: null } },
    { do: enable, by: "ユーザー", expect: { status: "有効" } },
  ],
  "何をするかを読み取れなければ、作れない（はっきりしない）": [
    { do: initial, by: "ユーザー", input: "はっきりしない", denied: "何をするかを読み取れたときだけ（はっきりしない・ルールではできない操作を含む・条件が混ざっている・答えが返らないなら、直してもらう）" },
  ],
  "何をするかを読み取れなければ、作れない（送る・消すなど、ルールではできない操作）": [
    { do: initial, by: "ユーザー", input: "できない操作", denied: "何をするかを読み取れたときだけ（はっきりしない・ルールではできない操作を含む・条件が混ざっている・答えが返らないなら、直してもらう）" },
  ],
  "何をするかを読み取れなければ、作れない（答えが返らない）": [
    { do: initial, by: "ユーザー", input: "答えが返らない", denied: "何をするかを読み取れたときだけ（はっきりしない・ルールではできない操作を含む・条件が混ざっている・答えが返らないなら、直してもらう）" },
  ],
  "書き換えは、読み取れたときだけ保存できる": [
    { do: initial, by: "ユーザー", input: "ユーザーのルール" },
    { do: edit, by: "ユーザー", input: "できない操作", denied: "何をするかを読み取れたときだけ（はっきりしない・ルールではできない操作を含む・条件が混ざっている・答えが返らないなら、直してもらう）" },
    { do: edit, by: "ユーザー", input: "読み取れた", expect: { status: "有効", enabledAt: "2026-11-28T00:00:00Z" } },
    { do: remove, by: "ユーザー", expect: { status: "消した" } },
    { do: edit, by: "ユーザー", input: "読み取れた", denied: "消していないときだけ" },
    { do: remove, by: "ユーザー", denied: "消していないときだけ" },
    { do: enable, by: "ユーザー", denied: "止めてあるときだけ" },
  ],
  "組み込みのルールは、初めは止めてあり、ユーザーが有効にする": [
    { do: initial, by: "アプリ", input: "組み込みのルール", expect: { status: "止めてある", origin: "組み込み", enabledAt: null } },
    { do: enable, by: "アプリ", denied: "ユーザーだけ" },
    { do: enable, by: "ユーザー", expect: { status: "有効" } },
    { do: edit, by: "ユーザー", input: "読み取れた", denied: "ユーザーのルールだけ（組み込みのルールは書き換えられない）" },
    { do: remove, by: "ユーザー", denied: "ユーザーのルールだけ（組み込みのルールは消せない。止める）" },
    { do: disable, by: "ユーザー", expect: { status: "止めてある" } },
    { do: builtinChanged, by: "アプリ", denied: "有効なときだけ" },
  ],
  "組み込みのルールの中身が変わったら、止めてある状態に戻す": [
    { do: initial, by: "アプリ", input: "組み込みのルール" },
    { do: enable, by: "ユーザー" },
    { do: builtinChanged, by: "ユーザー", denied: "アプリだけ" },
    { do: builtinChanged, by: "アプリ", expect: { status: "止めてある", enabledAt: null } },
  ],
  "ユーザーのルールは、組み込みのルールの中身の変化で止まらない": [
    { do: initial, by: "ユーザー", input: "ユーザーのルール" },
    { do: builtinChanged, by: "アプリ", denied: "組み込みのルールだけ" },
  ],
  "何をするかを読み取れなければ、作れない（条件が混ざっている）": [
    { do: initial, by: "ユーザー", input: "条件が混ざっている", denied: "何をするかを読み取れたときだけ（はっきりしない・ルールではできない操作を含む・条件が混ざっている・答えが返らないなら、直してもらう）" },
  ],
  "組み込みのルールを作るのはアプリだけ": [{ do: initial, by: "ユーザー", input: "組み込みのルール", denied: "ユーザーのルールはユーザー、組み込みのルールはアプリだけ" }],
  "ユーザーのルールを作るのはユーザーだけ": [{ do: initial, by: "アプリ", input: "ユーザーのルール", denied: "ユーザーのルールはユーザー、組み込みのルールはアプリだけ" }],
  "ルールを変えるのはユーザーだけ": [
    { do: initial, by: "ユーザー", input: "ユーザーのルール" },
    { do: disable, by: "アプリ", denied: "ユーザーだけ" },
    { do: edit, by: "アプリ", input: "読み取れた", denied: "ユーザーだけ" },
    { do: remove, by: "アプリ", denied: "ユーザーだけ" },
  ],
};

export const questions = [
  {
    ask: "charter と ADR-0014 には「アプリが自分で決めたルールで書き込むことはしない」とある。組み込みのルールは初めは止めておき、ユーザーが有効にしたら決めたとみなす形にしたが、文面と食い違って見える。ADR-0014 を置き換える ADR を書き、charter を「アプリが用意したルールは、ユーザーが有効にしたときだけ書き込む」に改めてよいか？",
    about: enable,
  },
  {
    ask: "ルールで変えた Task の変化（完了にした など）を、ほかのルールのきっかけにするか？ 案: 出来事のきっかけにはする（完了にしたらアーカイブ を続けて当てたい）、判定するきっかけにはしない（「対象外にする」と「やることにする」のルールが行き来して終わらなくなるのを防ぐ）",
    about: { status: "有効" },
  },
  {
    ask: "ルールで書き込む「Task が持つ事実」を、どこまでに限るか？ 振り分けで AI が誤って紐づけた事実もありうる。案: ユーザーが紐づけた事実と、識別子で確実に紐づいた事実（同じスレッドなど）だけにし、AI が判断して紐づけた事実には書き込まない",
    about: initial,
  },
];

export const reviewed = {
  "unused-field:enabledAt": "有効にした時刻は、ルールを当てるきっかけを選ぶのに使う（Rule Run の「有効にしたあとに起きたきっかけだけ」）。ルールの操作の可否は変えない。有効なときだけ時刻があることを、不変条件で確かめるために読んでいる",
};
