import { ensure } from "@yutaura/live-spec";

/**
 * Priority（Task の優先度 1 つ）。「今やるべきこと」を示すための、Task ごとの優先度の段階と、その決まり方。
 * 規則で決まるものは規則で、それ以外は Decisions の判定で決める（ADR-0003・ADR-0022）。規則に使う材料は期限と自分を待っている人だけで、ほかの材料（会議の前・自分が止めている PR など）は判定に任せる。
 * 答えが返らない・閾値の間・断られた（refusal）なら「段階未定」に倒し、低い優先度とは扱わない（fail closed）。段階未定の Task は、ボードで「今日やる」の上に印を付けて出し、ユーザーに決めてもらう。
 * ユーザーが決めた優先度は、ユーザーが外すまで AI が変えない（理由は入力しない）。
 * 判定するのは、要確認と todo の Task だけ（仕分け中・終わった Task は判定しない。やり直した Task は判定し直す）。
 * Task の外に置くのは、日が変わるたびにすべての Task を判定し直すので、その判定を Task の更新と切り離すため。
 * 判定の材料（期限・自分を待っている人）は、Task の dossier の「アプリが書いた信頼できる情報」から作る。同じ段階の中の並びは、期限の近い順・更新の新しい順（一覧の見せ方で、ここでは持たない）。
 */
export type Priority = {
  /** 優先度がどう決まったか */
  status: Status;
  /** @ref task */
  taskId: string;
  /** 優先度の段階（はじめて判定する前・段階未定なら null。判定し直す間は、前の段階を残す） */
  level: Level | null;
  /** なぜその段階か（見せるための一言。「今日が期限」など） */
  reason: string | null;
  /** 判定に使った材料（Task の事実と項目）。変わったら判定し直す */
  basisFingerprint: string;
};

/** 優先度の段階 */
export type Level = "今日やる" | "今週やる" | "いつか";

export const Status = {
  /** まだ判定していない（Task ができた・材料が変わった・日が変わった）。判定し直す間は、前の段階のまま並べる */
  pending: "未判定",
  /** 規則か判定で決まった */
  byApp: "アプリが決めた",
  /** 判定の答えが返らない・閾値の間・断られた。ユーザーに決めてもらう（Task の「要確認」の列とは別） */
  undecided: "段階未定",
  /** ユーザーが決めた（AI は変えない） */
  byUser: "ユーザーが決めた",
  /** Task が終わった・完了待ち・やらないことにしたので、判定しない（やり直したら判定し直す） */
  stopped: "判定しない",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

/** 判定表「規則で決まる優先度」の結果 */
type RuleResult = Level | "規則では決めない";

type Actor = { kind: "sync" } | { kind: "agent" } | { kind: "user" };

/** 同期: 規則で決める・材料や日付の変化に気づく。AI: Decisions で判定する（Claude Code などの Agent ではない） */
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
  ensure(priority.status === "未判定" || priority.status === "段階未定", "未判定・段階未定のときだけ");
  ensure(rule !== "規則では決めない", "規則で段階が出たときだけ");
  return rule === "今日やる"
    ? { ...priority, status: "アプリが決めた", level: "今日やる", reason: "今日が期限" }
    : { ...priority, status: "アプリが決めた", level: "今週やる", reason: "今週が期限" };
}

/**
 * 判定した（規則で決まらなかったものだけ）
 *
 * Decisions で、いちばん確率の高い段階が閾値以上なら、その段階に決める。閾値の間・断られた・形に合わない・答えが返らないなら、段階未定にする。
 */
export function judge(priority: Priority, actor: Actor, rule: RuleResult, result: Level | "閾値の間・断られた・形に合わない" | "答えが返らない", basis: "今の材料" | "古い材料"): Priority {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(priority.status === "未判定" || priority.status === "段階未定", "未判定・段階未定のときだけ");
  ensure(rule === "規則では決めない", "規則で決まらなかったときだけ");
  ensure(basis === "今の材料", "判定に渡した材料が今のものと同じときだけ（判定の間に材料が変わったら、答えを捨てて判定し直す）");
  if (result === "今日やる" || result === "今週やる" || result === "いつか") return { ...priority, status: "アプリが決めた", level: result, reason: "判定した" };
  return { ...priority, status: "段階未定", level: null, reason: null };
}

/** ユーザーが優先度を決める（段階未定に答える・アプリが決めたものを変える） */
export function setByUser(priority: Priority, actor: Actor): Priority {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...priority, status: "ユーザーが決めた", level: "今日やる", reason: "ユーザーが決めた" };
}

/** ユーザーが決めた優先度を外す（アプリに決め直させる。決め直すまで、ユーザーが決めた段階のまま並べる） */
export function clearByUser(priority: Priority, actor: Actor): Priority {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(priority.status === "ユーザーが決めた", "ユーザーが決めたときだけ");
  return { ...priority, status: "未判定" };
}

/**
 * 判定の材料（Task の事実と項目）が変わった・日が変わった
 *
 * アプリが決めた・段階未定・判定している途中の優先度は、判定し直す（「今週まで」が翌日に「今日まで」になる・期限が過ぎる、を拾うため、日が変わったときも）。段階未定は、決まるまで段階未定の印のまま見せる。ユーザーが決めた優先度は変えない。
 */
export function basisChanged(priority: Priority, actor: Actor, _why: "材料が変わった" | "日が変わった"): Priority {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(priority.status !== "ユーザーが決めた", "ユーザーが決めた優先度は変えない");
  ensure(priority.status !== "判定しない", "判定する Task のときだけ（終わった Task は判定しない）");
  return { ...priority, status: priority.status === "段階未定" ? "段階未定" : "未判定", basisFingerprint: "b2" };
}

/** 判定をやめる（Task が終わった・完了待ちになった・やらないことにした） */
export function stop(priority: Priority, actor: Actor): Priority {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(priority.status !== "判定しない", "判定しているときだけ");
  return { ...priority, status: "判定しない" };
}

/** 判定し直す（Task をやり直した） */
export function resume(priority: Priority, actor: Actor): Priority {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(priority.status === "判定しない", "判定しないときだけ");
  return { ...priority, status: "未判定", basisFingerprint: "b2" };
}

export const inputs = {
  decideByRule: { 今日やる: ["今日やる"], 今週やる: ["今週やる"], 規則で決まらない: ["規則では決めない"] },
  judge: {
    今日やる: ["規則では決めない", "今日やる", "今の材料"],
    今週やる: ["規則では決めない", "今週やる", "今の材料"],
    いつか: ["規則では決めない", "いつか", "今の材料"],
    閾値の間: ["規則では決めない", "閾値の間・断られた・形に合わない", "今の材料"],
    答えが返らない: ["規則では決めない", "答えが返らない", "今の材料"],
    規則で決まった: ["今日やる", "今週やる", "今の材料"],
    古い材料: ["規則では決めない", "今週やる", "古い材料"],
  },
  basisChanged: { 材料: ["材料が変わった"], 日: ["日が変わった"] },
};

export const invariants = {
  "決まっているときは段階と理由があり、段階未定のときはない": (priority: Priority) =>
    priority.status === "段階未定" ? priority.level === null && priority.reason === null
    : priority.status === "未判定" || priority.status === "判定しない" ? (priority.level === null) === (priority.reason === null)
    : priority.level !== null && priority.reason !== null,
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
  { from: decideByRule, to: "task", action: "notePriority", label: "段階が変わったときだけ、Task の変化として残す（同じ段階に決め直したときは残さない）" },
  { from: judge, to: "task", action: "notePriority", label: "段階が変わった・段階未定になったときだけ、Task の変化として残す" },
  { from: setByUser, to: "task", action: "notePriority", label: "ユーザーが決めた段階を、Task の変化として残す（ユーザーが変えたので既読）" },
  { from: clearByUser, to: "task", action: "notePriority", label: "ユーザーが決めた段階を外したことを、Task の変化として残す（既読）" },
];

export const scenarios = {
  "判定の間に材料が変わったら、古い材料での答えは捨てる": [
    { do: initial, by: "同期" },
    { do: basisChanged, by: "同期", input: "材料", expect: { status: "未判定" } },
    { do: judge, by: "AI", input: "古い材料", denied: "判定に渡した材料が今のものと同じときだけ（判定の間に材料が変わったら、答えを捨てて判定し直す）" },
    { do: judge, by: "AI", input: "今日やる", expect: { level: "今日やる" } },
  ],
  "段階未定は、判定し直す間も段階未定のまま見せる": [
    { do: initial, by: "同期" },
    { do: judge, by: "AI", input: "閾値の間", expect: { status: "段階未定" } },
    { do: basisChanged, by: "同期", input: "日", expect: { status: "段階未定" } },
    { do: judge, by: "AI", input: "今週やる", expect: { status: "アプリが決めた" } },
  ],
  "終わった Task は判定せず、やり直したら判定し直す": [
    { do: initial, by: "同期" },
    { do: judge, by: "AI", input: "今週やる" },
    { do: resume, by: "同期", denied: "判定しないときだけ" },
    { do: stop, by: "AI", denied: "同期だけ" },
    { do: stop, by: "同期", expect: { status: "判定しない" } },
    { do: stop, by: "同期", denied: "判定しているときだけ" },
    { do: resume, by: "AI", denied: "同期だけ" },
    { do: basisChanged, by: "同期", input: "日", denied: "判定する Task のときだけ（終わった Task は判定しない）" },
    { do: resume, by: "同期", expect: { status: "未判定", level: "今週やる" } },
  ],
  "規則で今週やるに決まる": [
    { do: initial, by: "同期" },
    { do: decideByRule, by: "同期", input: "今週やる", expect: { level: "今週やる" } },
  ],
  "今日が期限の Task は、規則で今日やるにする": [
    { do: initial, by: "同期", expect: { status: "未判定" } },
    { do: judge, by: "AI", input: "規則で決まった", denied: "規則で決まらなかったときだけ" },
    { do: decideByRule, by: "同期", input: "今日やる", expect: { status: "アプリが決めた", level: "今日やる" } },
    { do: decideByRule, by: "同期", input: "今日やる", denied: "未判定・段階未定のときだけ" },
    { do: judge, by: "AI", input: "今週やる", denied: "未判定・段階未定のときだけ" },
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
  "閾値の間・断られたなら段階未定にする": [
    { do: initial, by: "同期" },
    { do: judge, by: "AI", input: "閾値の間", expect: { status: "段階未定" } },
  ],
  "日が変わったら判定し直す（今週までが今日までになる）": [
    { do: initial, by: "同期" },
    { do: judge, by: "AI", input: "今週やる" },
    { do: basisChanged, by: "同期", input: "日", expect: { status: "未判定", level: "今週やる" } },
    { do: decideByRule, by: "同期", input: "今日やる", expect: { level: "今日やる" } },
  ],
  "材料が変わったら判定し直すが、ユーザーが決めた優先度は変えない": [
    { do: initial, by: "同期" },
    { do: judge, by: "AI", input: "今週やる" },
    { do: basisChanged, by: "同期", input: "材料", expect: { status: "未判定" } },
    { do: basisChanged, by: "同期", input: "材料", expect: { status: "未判定" } },
    { do: setByUser, by: "ユーザー" },
    { do: basisChanged, by: "同期", input: "日", denied: "ユーザーが決めた優先度は変えない" },
    { do: clearByUser, by: "ユーザー", expect: { status: "未判定", level: "今日やる" } },
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

export const reviewed = {
  "equivalent-states:未判定 · level=なし · reason=なし/段階未定 · level=なし · reason=なし/未判定 · 今日やる · 今日が期限/未判定 · 今週やる · 今週が期限/未判定 · 今日やる · 判定した/未判定 · 今週やる · 判定した/未判定 · いつか · 判定した/未判定 · 今日やる · ユーザーが決めた": "判定し直す間・段階未定は、できること（判定する・材料や日が変わったら判定し直す・ユーザーが決める）は同じだが、見せ方が違う（前の段階のまま並べる・段階未定の印を付ける・はじめての判定の前は並べない）",
  "equivalent-states:アプリが決めた · 今日やる · 今日が期限/アプリが決めた · 今週やる · 今週が期限/アプリが決めた · 今日やる · 判定した/アプリが決めた · 今週やる · 判定した/アプリが決めた · いつか · 判定した": "アプリが決めた段階ごとに、できることは同じだが、一覧の並びと見せる理由が違う",
  "equivalent-states:判定しない · level=なし · reason=なし/判定しない · 今日やる · 今日が期限/判定しない · 今週やる · 今週が期限/判定しない · 今日やる · 判定した/判定しない · 今週やる · 判定した/判定しない · いつか · 判定した/判定しない · 今日やる · ユーザーが決めた": "判定しない Task の優先度は見せないが、やり直したときに前の段階のまま並べるために残す",
  "indistinguishable-example:judge:閾値の間,答えが返らない": "どちらも、低い優先度ではなく段階未定に倒す（fail closed）。返らなかったのか、閾値の間・断られたのかは記録では分けるが、できることは同じ",
  "anytime:setByUser": "ユーザーはいつでも優先度を決められる（段階未定に答える・アプリが決めたものを変える・自分で決め直す）",
  "ignores-input:basisChanged": "材料が変わっても日が変わっても、同じく判定し直す。どちらで判定し直したかは記録のために受け取る",
  "unused-field:reason": "なぜその段階かは、ユーザーに見せる一言で、操作の可否は変えない。決まっているときだけあることを、不変条件で確かめるために読んでいる",
};
