import { ensure } from "@yutaura/live-spec";

/**
 * AI の使い道 1 つ（Decisions・Generation・Agent のどれか）。AI の設定の中にあり、AI の設定を通してだけ扱う。
 * 認証が通らなくなったら、AI の設定ごと（アプリ全体を）使えない状態にする（fail closed）。
 * 断られた（refusal）・回数の上限・ネットワークの失敗は、使えなくなったとはしない。その回の判定だけ要確認にする。
 * spec の例では、使い道を Decisions で代表させる（Generation・Agent も同じ振る舞い）。
 */
export type AiUse = {
  /** 使えるか */
  status: Status;
  /** どの使い道か（Decisions・Generation・Agent。作ったときに決まる） */
  kind: string;
  /** どれを使うか（Decisions・Generation ならプロバイダとモデル、Agent ならどの Agent か。形は種類ごとに provider が決める） */
  choice: { provider: string; model: string | null } | null;
  /** Decisions の閾値（todo 以上なら todo、review 以上なら要確認。Decisions のときだけ） */
  thresholds: { todo: number; review: number } | null;
  /** 認証が通らないときの理由 */
  problem: "API キーが切れた" | "権限がない" | null;
};

export const Status = {
  /** まだ設定していない */
  unset: "未設定",
  /** 設定して確かめた */
  usable: "使える",
  /** 認証が通らない（API キーが切れた・権限がない）。直すまで、アプリ全体を使えない */
  rejected: "認証が通らない",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "user" } | { kind: "app" };

/** アプリ: AI を呼んで、認証が通らないことに気づく */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

/** 使い道を用意する（初めて起動したとき、3 つとも未設定で作る） */
export function initial(actor: Actor): AiUse {
  ensure(actor.kind === "app", "アプリだけ");
  return { status: "未設定", kind: "Decisions", choice: null, thresholds: null, problem: null };
}

/** 設定する・選び直す・直す（どれを使うかを選び、認証を確かめて通ったときだけ。いつでも選び直せる） */
export function configure(use: AiUse, actor: Actor, check: "通った" | "通らない"): AiUse {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(check === "通った", "認証を確かめて通ったときだけ");
  return { ...use, status: "使える", choice: { provider: "openai", model: "gpt-6-luna" }, thresholds: { todo: 0.8, review: 0.4 }, problem: null };
}

/** 認証が通らなかった（呼んだら断られた） */
export function reject(use: AiUse, actor: Actor): AiUse {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(use.status === "使える", "使えるときだけ");
  return { ...use, status: "認証が通らない", problem: "API キーが切れた" };
}

export const inputs = {
  configure: { 通った: ["通った"], 通らない: ["通らない"] },
};

export const invariants = {
  "未設定のときだけ、どれを使うかがない": (use: AiUse) => (use.status === "未設定") === (use.choice === null),
  "認証が通らないときだけ、理由がある": (use: AiUse) => (use.status === "認証が通らない") === (use.problem !== null),
  "設定したあとは、未設定に戻らない（使い道は外せない。外すとアプリが使えなくなるので）": (before: AiUse, after: AiUse) => before.status === "未設定" || after.status !== "未設定",
  "Decisions の閾値は 0〜1 で、要確認の閾値は todo の閾値以下": (use: AiUse) =>
    use.thresholds === null || (0 <= use.thresholds.review && use.thresholds.review <= use.thresholds.todo && use.thresholds.todo <= 1),
};

export const links = [
  { from: configure, to: "ai-settings", action: "finishSetup", label: "3 つとも設定して確かめたら、アプリを使えるようにする" },
  { from: configure, to: "ai-settings", action: "resume", label: "認証が通らなかったものを直して、3 つとも使えるなら、また使えるようにする" },
  { from: reject, to: "ai-settings", action: "suspend", label: "アプリ全体を使えない状態にする" },
];

export const reviewed = {
  "equivalent-states:未設定 · choice=なし · thresholds=なし · problem=なし/認証が通らない · {…} · { review: 0.4, todo: 0.8 } · API キーが切れた": "未設定と認証が通らないは、どちらも設定（選び直し）しかできず、アプリ全体を使えない点も同じ。違うのはユーザーに見せる案内（初めての設定か、通らない理由と直し方か）",
  "anytime:configure": "どれを使うかは、いつでも選び直せる（未設定・使える・認証が通らない のどれでも）",
  "unused-field:kind": "どの使い道かは作ったときに決まり、振る舞いは 3 つとも同じ。3 つが 1 つずつあることは、集約の不変条件で確かめる",
  "unused-field:choice": "どれを使うかは呼び出し先を決めるもので、可否は変えない。未設定のときだけないことを、不変条件で確かめるために読んでいる",
  "unused-field:thresholds": "閾値は判定の仕方を決めるもので、可否は変えない。範囲を、不変条件で確かめるために読んでいる",
  "unused-field:problem": "認証が通らない理由は、ユーザーに見せるもので、可否は変えない。認証が通らないときだけあることを、不変条件で確かめるために読んでいる",
};

export const scenarios = {
  "設定して確かめたら使える。API キーが切れたら、直すまでアプリ全体を使えない": [
    { do: initial, by: "アプリ", expect: { status: "未設定" } },
    { do: reject, by: "アプリ", denied: "使えるときだけ" },
    { do: configure, by: "ユーザー", input: "通らない", denied: "認証を確かめて通ったときだけ" },
    { do: configure, by: "アプリ", input: "通った", denied: "ユーザーだけ" },
    { do: configure, by: "ユーザー", input: "通った", expect: { status: "使える" } },
    { do: reject, by: "ユーザー", denied: "アプリだけ" },
    { do: reject, by: "アプリ", expect: { status: "認証が通らない" } },
    { do: reject, by: "アプリ", denied: "使えるときだけ" },
    { do: configure, by: "ユーザー", input: "通った", expect: { status: "使える", problem: null } },
  ],
  "使い道を用意するのはアプリだけ": [{ do: initial, by: "ユーザー", denied: "アプリだけ" }],
};
