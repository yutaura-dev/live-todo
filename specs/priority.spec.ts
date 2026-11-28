import { ensure } from "@yutaura/live-spec";

/**
 * Priority（Task の優先度 1 つ）。「今やるべきこと」を示すための、Task ごとの優先度の段階と、その決まり方。
 * 規則で決まるものは規則で、それ以外は判定で決める（ADR-0003）。判定は、LLM Profile が確率付きの判定（Decisions）を使えるならそれで、使えなければ chat の LLM の決まった形の答え（uncertain を選べる）で行う。
 * 答えが返らない・閾値の間・uncertain なら「段階未定」に倒し、低い優先度とは扱わない（fail closed）。
 * ユーザーが決めた優先度は、ユーザーが外すまで AI が変えない。
 * 判定の材料（期限・自分を待っている人）は、Task の dossier の「アプリが書いた信頼できる情報」から作る。同じ段階の中の並びは、期限の近い順・更新の新しい順（一覧の見せ方で、ここでは持たない）。
 */
export type Priority = {
  /** 優先度がどう決まったか */
  status: Status;
  /** @ref task */
  taskId: string;
  /** 優先度の段階（まだ決まっていない・段階未定なら null） */
  level: Level | null;
  /** なぜその段階か（見せるための一言。「今日が期限」など） */
  reason: string | null;
  /** 判定に使った材料（Task の事実と項目）。変わったら判定し直す */
  basisFingerprint: string;
};

/** 優先度の段階 */
export type Level = "今日やる" | "今週やる" | "いつか";

export const Status = {
  /** まだ判定していない（Task ができた・材料が変わった・日が変わった） */
  pending: "未判定",
  /** 規則か判定で決まった */
  byApp: "アプリが決めた",
  /** 判定の答えが返らない・閾値の間・uncertain だった。ユーザーに決めてもらう（Task の「要確認」の列とは別） */
  undecided: "段階未定",
  /** ユーザーが決めた（AI は変えない） */
  byUser: "ユーザーが決めた",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

/** 判定表「規則で決まる優先度」の結果 */
type RuleResult = Level | "規則では決めない";

type Actor = { kind: "sync" } | { kind: "agent" } | { kind: "user" };

/** 同期: 規則で決める・材料や日付の変化に気づく。AI: 判定する（Decisions か、chat の LLM） */
export const actors: Record<string, Actor> = {
  同期: { kind: "sync" },
  AI: { kind: "agent" },
  ユーザー: { kind: "user" },
};

/** Task ができたので、優先度を決め始める */
export function initial(actor: Actor): Priority {
  ensure(actor.kind === "sync", "同期だけ");
  return { status: "未判定", taskId: "t1", level: null, reason: null, basisFingerprint: "b1" };
}

/** 規則で決まる（判定表「規則で決まる優先度」で段階が出た。LLM は呼ばない） */
export function decideByRule(priority: Priority, actor: Actor, rule: RuleResult): Priority {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(priority.status === "未判定", "未判定のときだけ");
  ensure(rule !== "規則では決めない", "規則で段階が出たときだけ");
  return { ...priority, status: "アプリが決めた", level: "今日やる", reason: "今日が期限" };
}

/**
 * 判定した（規則で決まらなかったものだけ）
 *
 * いちばん確率の高い段階が閾値以上なら、その段階に決める。閾値の間・uncertain・答えが返らない（断られた・形に合わない）なら、段階未定にする。
 */
export function judge(priority: Priority, actor: Actor, rule: RuleResult, result: "今週やる" | "いつか" | "閾値の間・uncertain" | "答えが返らない"): Priority {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(priority.status === "未判定", "未判定のときだけ");
  ensure(rule === "規則では決めない", "規則で決まらなかったときだけ");
  if (result === "今週やる" || result === "いつか") return { ...priority, status: "アプリが決めた", level: result, reason: "判定した" };
  return { ...priority, status: "段階未定", level: null, reason: null };
}

/** ユーザーが優先度を決める（段階未定に答える・アプリが決めたものを変える） */
export function setByUser(priority: Priority, actor: Actor): Priority {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...priority, status: "ユーザーが決めた", level: "今日やる", reason: "ユーザーが決めた" };
}

/** ユーザーが決めた優先度を外す（アプリに決め直させる） */
export function clearByUser(priority: Priority, actor: Actor): Priority {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(priority.status === "ユーザーが決めた", "ユーザーが決めたときだけ");
  return { ...priority, status: "未判定", level: null, reason: null };
}

/**
 * 判定の材料（Task の事実と項目）が変わった・日が変わった
 *
 * アプリが決めた・段階未定の優先度は、判定し直す（「今週まで」が翌日に「今日まで」になる・期限が過ぎる、を拾うため、日が変わったときも）。ユーザーが決めた優先度は変えない。
 */
export function basisChanged(priority: Priority, actor: Actor, _why: "材料が変わった" | "日が変わった"): Priority {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(priority.status === "アプリが決めた" || priority.status === "段階未定", "アプリが決めた・段階未定のときだけ（ユーザーが決めた優先度は変えない）");
  return { ...priority, status: "未判定", level: null, reason: null, basisFingerprint: "b2" };
}

export const inputs = {
  decideByRule: { 今日やる: ["今日やる"], 規則で決まらない: ["規則では決めない"] },
  judge: {
    今週やる: ["規則では決めない", "今週やる"],
    いつか: ["規則では決めない", "いつか"],
    閾値の間: ["規則では決めない", "閾値の間・uncertain"],
    答えが返らない: ["規則では決めない", "答えが返らない"],
    規則で決まった: ["今日やる", "今週やる"],
  },
  basisChanged: { 材料: ["材料が変わった"], 日: ["日が変わった"] },
};

export const invariants = {
  "決まっているときだけ、段階と理由がある": (priority: Priority) =>
    (priority.status === "アプリが決めた" || priority.status === "ユーザーが決めた") === (priority.level !== null && priority.reason !== null),
};

/** 規則で決まる優先度（LLM を呼ばずに決められるもの） */
function ruleLevel(input: { 期限: "過ぎた" | "今日まで" | "今週まで" | "なし・分からない"; 自分を待っている人: "いる" | "いない" }): RuleResult {
  if (input.期限 === "過ぎた" || input.期限 === "今日まで") return "今日やる";
  if (input.期限 === "今週まで") return input.自分を待っている人 === "いる" ? "今日やる" : "今週やる";
  return "規則では決めない";
}

export const decisions = {
  規則で決まる優先度: {
    decide: ruleLevel,
    cases: [
      { input: { 期限: "過ぎた", 自分を待っている人: "いない" }, expect: "今日やる" },
      { input: { 期限: "今日まで", 自分を待っている人: "いない" }, expect: "今日やる" },
      { input: { 期限: "今週まで", 自分を待っている人: "いる" }, expect: "今日やる" },
      { input: { 期限: "今週まで", 自分を待っている人: "いない" }, expect: "今週やる" },
      { input: { 期限: "なし・分からない", 自分を待っている人: "いる" }, expect: "規則では決めない" },
      { input: { 期限: "なし・分からない", 自分を待っている人: "いない" }, expect: "規則では決めない" },
    ],
  },
};

export const links = [
  { from: decideByRule, to: "task", label: "段階が変わったときだけ、Task の変化として残す（同じ段階に決め直したときは残さない）" },
  { from: judge, to: "task", label: "段階が変わった・段階未定になったときだけ、Task の変化として残す" },
  { from: setByUser, to: "task", label: "ユーザーが決めた段階を、Task の変化として残す（ユーザーが変えたので既読）" },
  { from: clearByUser, to: "task", label: "ユーザーが決めた段階を外したことを、Task の変化として残す（既読）" },
  { from: basisChanged, to: "task", label: "判定し直す間は、Task の変化を残さない（決まったときに残す）" },
];

export const scenarios = {
  "今日が期限の Task は、規則で今日やるにする": [
    { do: initial, by: "同期", expect: { status: "未判定" } },
    { do: judge, by: "AI", input: "規則で決まった", denied: "規則で決まらなかったときだけ" },
    { do: decideByRule, by: "同期", input: "今日やる", expect: { status: "アプリが決めた", level: "今日やる" } },
    { do: decideByRule, by: "同期", input: "今日やる", denied: "未判定のときだけ" },
  ],
  "規則で決まらないものは、判定する": [
    { do: initial, by: "同期" },
    { do: decideByRule, by: "同期", input: "規則で決まらない", denied: "規則で段階が出たときだけ" },
    { do: judge, by: "AI", input: "今週やる", expect: { status: "アプリが決めた", level: "今週やる" } },
  ],
  "急がないものは、いつかにする": [
    { do: initial, by: "同期" },
    { do: judge, by: "AI", input: "いつか", expect: { level: "いつか" } },
  ],
  "答えが返らなければ、低い優先度ではなく段階未定にする": [
    { do: initial, by: "同期" },
    { do: judge, by: "AI", input: "答えが返らない", expect: { status: "段階未定", level: null } },
    { do: setByUser, by: "ユーザー", expect: { status: "ユーザーが決めた" } },
  ],
  "閾値の間・uncertain なら段階未定にする": [
    { do: initial, by: "同期" },
    { do: judge, by: "AI", input: "閾値の間", expect: { status: "段階未定" } },
  ],
  "日が変わったら判定し直す（今週までが今日までになる）": [
    { do: initial, by: "同期" },
    { do: judge, by: "AI", input: "今週やる" },
    { do: basisChanged, by: "同期", input: "日", expect: { status: "未判定" } },
    { do: decideByRule, by: "同期", input: "今日やる", expect: { level: "今日やる" } },
  ],
  "材料が変わったら判定し直すが、ユーザーが決めた優先度は変えない": [
    { do: initial, by: "同期" },
    { do: judge, by: "AI", input: "今週やる" },
    { do: basisChanged, by: "同期", input: "材料", expect: { status: "未判定" } },
    { do: basisChanged, by: "同期", input: "材料", denied: "アプリが決めた・段階未定のときだけ（ユーザーが決めた優先度は変えない）" },
    { do: setByUser, by: "ユーザー" },
    { do: basisChanged, by: "同期", input: "日", denied: "アプリが決めた・段階未定のときだけ（ユーザーが決めた優先度は変えない）" },
    { do: clearByUser, by: "ユーザー", expect: { status: "未判定" } },
    { do: clearByUser, by: "ユーザー", denied: "ユーザーが決めたときだけ" },
  ],
  "優先度を決め始めるのは同期だけ": [{ do: initial, by: "ユーザー", denied: "同期だけ" }],
  "段階を決めるのは決まった人だけ": [
    { do: initial, by: "同期" },
    { do: decideByRule, by: "AI", input: "今日やる", denied: "同期だけ" },
    { do: judge, by: "同期", input: "今週やる", denied: "AI だけ" },
    { do: setByUser, by: "同期", denied: "ユーザーだけ" },
    { do: basisChanged, by: "ユーザー", input: "材料", denied: "同期だけ" },
    { do: setByUser, by: "ユーザー" },
    { do: clearByUser, by: "同期", denied: "ユーザーだけ" },
  ],
};

export const questions = [
  {
    ask: "優先度の段階は「今日やる・今週やる・いつか」の 3 つでよいか？（今の実装には優先度がなく、ここで初めて決める）",
    about: judge,
  },
  {
    ask: "規則で決まる優先度（判定表）は、期限と自分を待っている人で決める形でよいか？ ほかに効く材料（会議の前・自分が止めている PR・何日も動いていない など）はあるか？",
    about: decideByRule,
  },
  {
    ask: "ユーザーが決めた優先度は、ユーザーが外すまで AI が変えない、でよいか？（期限が過ぎた・事実が大きく変わったときも変えない）。ユーザーが決めたときの理由は、一言を入力してもらうか、なしでよいか？",
    about: setByUser,
  },
  {
    ask: "段階未定の Task を、ボードのどこにどう見せるか？（今日やるの上に出す・印だけ付ける など。Task の「要確認」の列とは別）",
    about: { status: "段階未定" },
  },
  {
    ask: "優先度を Task の外の集約にしたが、Task の中の値にするか？ 中にすると「1 つの Task に 1 つ」「Task が閉じたら止まる」「更新マークは Task の項目の変化だけ」と自然に合う。外にすると、たびたび走る判定を Task の更新と切り離せる",
    about: initial,
  },
  {
    ask: "判定し直す間（未判定）は段階が null になり、Task が並びから外れる。前の段階を残したまま判定し直すか？",
    about: basisChanged,
  },
  {
    ask: "どの Task を判定するか？（仕分け中・要確認・終わった Task も判定するか。費用と見せ方に関わる）",
    about: initial,
  },
];

export const reviewed = {
  "unused-field:reason": "なぜその段階かは、ユーザーに見せる一言で、操作の可否は変えない。決まっているときだけあることを、不変条件で確かめるために読んでいる",
  "equivalent-states:アプリが決めた · 今日やる · 今日が期限/アプリが決めた · 今週やる · 判定した/アプリが決めた · いつか · 判定した/段階未定 · level=なし · reason=なし": "アプリが決めた（段階ごと）と段階未定は、できること（材料・日が変わったら判定し直す・ユーザーが決める）は同じだが、見せ方が違う（段階は一覧の並びに効き、段階未定はユーザーに決めてもらう）",
};
