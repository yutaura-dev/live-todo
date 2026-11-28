import { ensure } from "@yutaura/live-spec";

/**
 * Priority（Task の優先度 1 つ）。「今やるべきこと」を示すための、Task ごとの優先度の段階と、その決まり方。
 * 優先度は、規則で決まるものは規則で、それ以外は Decisions で判定する（ADR-0003）。答えが返らない・想定外の応答は「要確認」に倒し、低い優先度とは扱わない（fail closed）。
 * ユーザーが決めた優先度は、ユーザーが外すまで AI が変えない。
 * 同じ段階の中の並びは、期限の近い順・更新の新しい順に並べる（一覧の見せ方で、ここでは持たない）。
 */
export type Priority = {
  /** 優先度がどう決まったか */
  status: Status;
  /** @ref task */
  taskId: string;
  /** 優先度の段階（まだ決まっていない・要確認なら null） */
  level: Level | null;
  /** なぜその段階か（見せるための一言。「今日までのレビュー依頼」など） */
  reason: string | null;
  /** 判定に使った材料（Task の事実と項目）。変わったら判定し直す */
  basisFingerprint: string;
};

/** 優先度の段階 */
export type Level = "今日やる" | "今週やる" | "いつか";

export const Status = {
  /** まだ判定していない（Task ができた・材料が変わった） */
  pending: "未判定",
  /** 規則か Decisions で決まった */
  byApp: "アプリが決めた",
  /** 判定の答えが返らない・閾値の間だった。ユーザーに決めてもらう */
  review: "要確認",
  /** ユーザーが決めた（AI は変えない） */
  byUser: "ユーザーが決めた",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "app" } | { kind: "decisions" } | { kind: "user" };

/** アプリ: 規則で決める・判定を頼む。Decisions: 確率付きで段階を答える */
export const actors: Record<string, Actor> = {
  アプリ: { kind: "app" },
  Decisions: { kind: "decisions" },
  ユーザー: { kind: "user" },
};

/** Task ができたので、優先度を決め始める */
export function initial(actor: Actor): Priority {
  ensure(actor.kind === "app", "アプリだけ");
  return { status: "未判定", taskId: "t1", level: null, reason: null, basisFingerprint: "b1" };
}

/** 規則で決まる（判定表「規則で決まる優先度」に当てはまる。LLM は呼ばない） */
export function decideByRule(priority: Priority, actor: Actor): Priority {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(priority.status === "未判定", "未判定のときだけ");
  return { ...priority, status: "アプリが決めた", level: "今日やる", reason: "今日までのレビュー依頼" };
}

/**
 * Decisions が判定した
 *
 * いちばん確率の高い段階が閾値以上なら、その段階に決める。閾値の間・答えが返らない（断られた・形に合わない）なら、要確認にする。
 */
export function judge(priority: Priority, actor: Actor, result: "閾値以上" | "閾値の間" | "答えが返らない"): Priority {
  ensure(actor.kind === "decisions", "Decisions だけ");
  ensure(priority.status === "未判定", "未判定のときだけ");
  if (result === "閾値以上") return { ...priority, status: "アプリが決めた", level: "今週やる", reason: "今週の会議の準備" };
  return { ...priority, status: "要確認", level: null, reason: null };
}

/** ユーザーが優先度を決める（要確認に答える・アプリが決めたものを変える） */
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
 * 判定の材料（Task の事実と項目）が変わった
 *
 * アプリが決めた・要確認の優先度は、判定し直す。ユーザーが決めた優先度は変えない。
 */
export function basisChanged(priority: Priority, actor: Actor): Priority {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(priority.status === "アプリが決めた" || priority.status === "要確認", "アプリが決めた・要確認のときだけ（ユーザーが決めた優先度は変えない）");
  return { ...priority, status: "未判定", level: null, reason: null, basisFingerprint: "b2" };
}

export const inputs = {
  judge: { 閾値以上: ["閾値以上"], 閾値の間: ["閾値の間"], 答えが返らない: ["答えが返らない"] },
};

export const invariants = {
  "決まっているときだけ、段階と理由がある": (priority: Priority) =>
    (priority.status === "アプリが決めた" || priority.status === "ユーザーが決めた") === (priority.level !== null && priority.reason !== null),
};

/** 規則で決まる優先度（LLM を呼ばずに決められるもの） */
function ruleLevel(input: { 期限: "今日まで" | "今週まで" | "なし・分からない"; 自分を待っている人: "いる" | "いない" }): Level | "規則では決めない" {
  if (input.期限 === "今日まで") return "今日やる";
  if (input.期限 === "今週まで") return input.自分を待っている人 === "いる" ? "今日やる" : "今週やる";
  return "規則では決めない";
}

export const decisions = {
  規則で決まる優先度: {
    decide: ruleLevel,
    cases: [
      { input: { 期限: "今日まで", 自分を待っている人: "いない" }, expect: "今日やる" },
      { input: { 期限: "今週まで", 自分を待っている人: "いる" }, expect: "今日やる" },
      { input: { 期限: "今週まで", 自分を待っている人: "いない" }, expect: "今週やる" },
      { input: { 期限: "なし・分からない", 自分を待っている人: "いる" }, expect: "規則では決めない" },
      { input: { 期限: "なし・分からない", 自分を待っている人: "いない" }, expect: "規則では決めない" },
    ],
  },
};

export const links = [
  { from: decideByRule, to: "task", label: "優先度が変わったことを、Task の変化として残す" },
  { from: judge, to: "task", label: "優先度が決まった・要確認になったことを、Task の変化として残す" },
];

export const scenarios = {
  "今日までのレビュー依頼は、規則で今日やるにする": [
    { do: initial, by: "アプリ", expect: { status: "未判定" } },
    { do: decideByRule, by: "アプリ", expect: { status: "アプリが決めた", level: "今日やる" } },
    { do: decideByRule, by: "アプリ", denied: "未判定のときだけ" },
  ],
  "規則で決まらないものは、Decisions で判定する": [
    { do: initial, by: "アプリ" },
    { do: judge, by: "Decisions", input: "閾値以上", expect: { status: "アプリが決めた", level: "今週やる" } },
  ],
  "答えが返らなければ、低い優先度ではなく要確認にする": [
    { do: initial, by: "アプリ" },
    { do: judge, by: "Decisions", input: "答えが返らない", expect: { status: "要確認", level: null } },
    { do: setByUser, by: "ユーザー", expect: { status: "ユーザーが決めた" } },
  ],
  "閾値の間なら要確認にする": [
    { do: initial, by: "アプリ" },
    { do: judge, by: "Decisions", input: "閾値の間", expect: { status: "要確認" } },
  ],
  "材料が変わったら判定し直すが、ユーザーが決めた優先度は変えない": [
    { do: initial, by: "アプリ" },
    { do: judge, by: "Decisions", input: "閾値以上" },
    { do: basisChanged, by: "アプリ", expect: { status: "未判定" } },
    { do: basisChanged, by: "アプリ", denied: "アプリが決めた・要確認のときだけ（ユーザーが決めた優先度は変えない）" },
    { do: setByUser, by: "ユーザー" },
    { do: basisChanged, by: "アプリ", denied: "アプリが決めた・要確認のときだけ（ユーザーが決めた優先度は変えない）" },
    { do: clearByUser, by: "ユーザー", expect: { status: "未判定" } },
    { do: clearByUser, by: "ユーザー", denied: "ユーザーが決めたときだけ" },
  ],
  "判定するのは決まった人だけ": [
    { do: initial, by: "ユーザー", denied: "アプリだけ" },
  ],
  "段階を決めるのは決まった人だけ": [
    { do: initial, by: "アプリ" },
    { do: decideByRule, by: "Decisions", denied: "アプリだけ" },
    { do: judge, by: "アプリ", input: "閾値以上", denied: "Decisions だけ" },
    { do: setByUser, by: "アプリ", denied: "ユーザーだけ" },
    { do: basisChanged, by: "ユーザー", denied: "アプリだけ" },
    { do: setByUser, by: "ユーザー" },
    { do: clearByUser, by: "アプリ", denied: "ユーザーだけ" },
  ],
};

export const reviewed = {
  "unused-field:reason": "なぜその段階かは、ユーザーに見せる一言で、操作の可否は変えない。決まっているときだけあることを、不変条件で確かめるために読んでいる",
  "equivalent-states:アプリが決めた · 今日やる · 今日までのレビュー依頼/アプリが決めた · 今週やる · 今週の会議の準備/要確認 · level=なし · reason=なし": "アプリが決めた（段階ごと）と要確認は、できることは同じ（材料が変わったら判定し直す・ユーザーが決める）だが、見せ方が違う（要確認は専用のレーンに置き、ユーザーに決めてもらう。段階は一覧の並びに効く）",
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
    ask: "ユーザーが決めた優先度は、ユーザーが外すまで AI が変えない、でよいか？（期限が過ぎた・事実が大きく変わったときも変えない）",
    about: setByUser,
  },
  {
    ask: "カスタムラベル（ADR-0004）は、Rule の操作の 1 つ（Task にラベルを付ける）にするか、別の集約にするか？ ADR-0019 でルールは Task に当てるようになったので、Rule の操作にまとめるのが自然に見える",
    about: initial,
  },
];
