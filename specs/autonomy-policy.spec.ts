import { ensure } from "@yutaura/live-spec";

/**
 * 自動でやってよい範囲（Autonomy Policy。PC に 1 つ）。AI が、ユーザーに頼まれず・承認されずに、どこまで自動でやってよいかをユーザーが決める。
 * 操作を 4 つの段に分ける。provider が、自分の操作（github.issue_comment・github.pull_request など）がどの段かを決める。
 * 1. 調べる: 書き込みを伴わない調査（コードを読む・CI のログを見る・メールを検索する）
 * 2. ローカルの書き込み: この PC の中に閉じた書き込み（worktree 内のファイル変更・パッケージのインストール など）
 * 3. 外への書き込み（下書き）: 外に書き込むが下書きにとどまるもの（draft の PR を作る・Gmail の下書きを作る）
 * 4. 外への書き込み（本番）: 外に本当に書き込むもの（issue にコメントする・PR を ready にする・メールを送る）
 * ユーザーは、全体の上限と、操作ごとの上限（issue へのコメントは本番まで、PR は下書きまで、など）と、ローカルの書き込みの範囲（worktree 内のファイル変更だけ、など）を決める。
 * provider は、段の違う書き込みを別の操作に分ける（draft の PR を作る github.pull_request.draft と、ready にする github.pull_request.ready など）。段は操作の名前だけで決まる。
 * 範囲を狭めたら、もう始めた作業・書き込みはそのまま続け、まだ始めていないものは狭めたあとの範囲で決め直す。
 * 範囲に入るものは、計画の Action Item の番が来たら自動で始め、外への書き込みも確かめずに書き込む。ユーザーが範囲を決めたことを、その範囲の書き込みの承認とみなす（charter・ADR-0023）。範囲に入らないものは、今までどおりユーザーが頼む・承認する。
 */
export type AutonomyPolicy = {
  /** 全体の上限（操作ごとに決めていなければ、これを使う） */
  defaultLimit: Level;
  /** 操作ごとの上限（provider が決めた操作の名前と、上限） */
  limits: { operation: string; limit: Level }[];
  /** ローカルの書き込みの範囲 */
  localScope: "worktree 内のファイル変更だけ" | "この PC の中ならどこでも";
};

export const Level = {
  /** 書き込みを伴わない調査 */
  read: "調べる",
  /** この PC の中に閉じた書き込み */
  local: "ローカルの書き込み",
  /** 外への書き込み（下書きまで） */
  draft: "外への書き込み（下書き）",
  /** 外への書き込み（本番） */
  live: "外への書き込み（本番）",
} as const;
export type Level = (typeof Level)[keyof typeof Level];

const ORDER: Level[] = ["調べる", "ローカルの書き込み", "外への書き込み（下書き）", "外への書き込み（本番）"];

type Actor = { kind: "user" } | { kind: "app" };

export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

/** 初めの範囲（ローカルの書き込みまで。ただし worktree 内のファイル変更だけ）。外への書き込みは、ユーザーが決めるまで自動でやらない */
export function initial(actor: Actor): AutonomyPolicy {
  ensure(actor.kind === "app", "アプリだけ");
  return { defaultLimit: "ローカルの書き込み", limits: [], localScope: "worktree 内のファイル変更だけ" };
}

/** 全体の上限を決める */
export function setDefaultLimit(policy: AutonomyPolicy, actor: Actor, limit: Level): AutonomyPolicy {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...policy, defaultLimit: limit };
}

/** 操作ごとの上限を決める（issue へのコメントは本番まで、など。同じ操作の上限は置き換える） */
export function setOperationLimit(policy: AutonomyPolicy, actor: Actor): AutonomyPolicy {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...policy, limits: [{ operation: "github.issue_comment", limit: "外への書き込み（本番）" }] };
}

/** 操作ごとの上限を外す（全体の上限に戻す） */
export function clearOperationLimit(policy: AutonomyPolicy, actor: Actor): AutonomyPolicy {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...policy, limits: [] };
}

/** ローカルの書き込みの範囲を決める */
export function setLocalScope(policy: AutonomyPolicy, actor: Actor, scope: AutonomyPolicy["localScope"]): AutonomyPolicy {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...policy, localScope: scope };
}

/** 自動でやってよいか（Action Item を自動で始めるか・外への書き込みを確かめずに書き込むかを、これで決める） */
function allowed(input: {
  操作の段: Level;
  操作ごとの上限: Level | "決めていない";
  全体の上限: Level;
  "ローカルの書き込みの場所": "worktree 内のファイル" | "worktree の外" | "ローカルの書き込みではない";
  ローカルの書き込みの範囲: AutonomyPolicy["localScope"];
}): "自動でやる" | "ユーザーが頼む・承認する" {
  const limit = input.操作ごとの上限 === "決めていない" ? input.全体の上限 : input.操作ごとの上限;
  if (ORDER.indexOf(input.操作の段) > ORDER.indexOf(limit)) return "ユーザーが頼む・承認する";
  if (input["ローカルの書き込みの場所"] === "worktree の外" && input.ローカルの書き込みの範囲 === "worktree 内のファイル変更だけ") return "ユーザーが頼む・承認する";
  return "自動でやる";
}

const W = "worktree 内のファイル変更だけ" as const;

export const inputs = {
  setDefaultLimit: { 調べる: ["調べる"], ローカル: ["ローカルの書き込み"], 下書き: ["外への書き込み（下書き）"], 本番: ["外への書き込み（本番）"] },
  setLocalScope: { worktree: ["worktree 内のファイル変更だけ"], どこでも: ["この PC の中ならどこでも"] },
};

export const invariants = {
  "同じ操作の上限は、1 つだけ": (policy: AutonomyPolicy) => new Set(policy.limits.map((limit) => limit.operation)).size === policy.limits.length,
};

export const decisions = {
  自動でやってよいか: {
    decide: allowed,
    cases: [
      { input: { 操作の段: "調べる", 操作ごとの上限: "決めていない", 全体の上限: "ローカルの書き込み", "ローカルの書き込みの場所": "ローカルの書き込みではない", ローカルの書き込みの範囲: W }, expect: "自動でやる" },
      { input: { 操作の段: "ローカルの書き込み", 操作ごとの上限: "決めていない", 全体の上限: "ローカルの書き込み", "ローカルの書き込みの場所": "worktree 内のファイル", ローカルの書き込みの範囲: W }, expect: "自動でやる" },
      { input: { 操作の段: "ローカルの書き込み", 操作ごとの上限: "決めていない", 全体の上限: "ローカルの書き込み", "ローカルの書き込みの場所": "worktree の外", ローカルの書き込みの範囲: W }, expect: "ユーザーが頼む・承認する" },
      { input: { 操作の段: "ローカルの書き込み", 操作ごとの上限: "決めていない", 全体の上限: "ローカルの書き込み", "ローカルの書き込みの場所": "worktree の外", ローカルの書き込みの範囲: "この PC の中ならどこでも" }, expect: "自動でやる" },
      { input: { 操作の段: "外への書き込み（下書き）", 操作ごとの上限: "決めていない", 全体の上限: "ローカルの書き込み", "ローカルの書き込みの場所": "ローカルの書き込みではない", ローカルの書き込みの範囲: W }, expect: "ユーザーが頼む・承認する" },
      { input: { 操作の段: "外への書き込み（下書き）", 操作ごとの上限: "決めていない", 全体の上限: "外への書き込み（下書き）", "ローカルの書き込みの場所": "ローカルの書き込みではない", ローカルの書き込みの範囲: W }, expect: "自動でやる" },
      { input: { 操作の段: "外への書き込み（本番）", 操作ごとの上限: "決めていない", 全体の上限: "外への書き込み（下書き）", "ローカルの書き込みの場所": "ローカルの書き込みではない", ローカルの書き込みの範囲: W }, expect: "ユーザーが頼む・承認する" },
      { input: { 操作の段: "外への書き込み（本番）", 操作ごとの上限: "決めていない", 全体の上限: "外への書き込み（本番）", "ローカルの書き込みの場所": "ローカルの書き込みではない", ローカルの書き込みの範囲: W }, expect: "自動でやる" },
      { input: { 操作の段: "外への書き込み（本番）", 操作ごとの上限: "外への書き込み（本番）", 全体の上限: "外への書き込み（下書き）", "ローカルの書き込みの場所": "ローカルの書き込みではない", ローカルの書き込みの範囲: W }, expect: "自動でやる" },
      { input: { 操作の段: "外への書き込み（下書き）", 操作ごとの上限: "調べる", 全体の上限: "外への書き込み（本番）", "ローカルの書き込みの場所": "ローカルの書き込みではない", ローカルの書き込みの範囲: W }, expect: "ユーザーが頼む・承認する" },
    ],
  },
};

export const reviewed = {
  "anytime:setDefaultLimit": "範囲はユーザーがいつでも決め直せる設定で、段階（ライフサイクル）を持たない",
  "anytime:setOperationLimit": "範囲はユーザーがいつでも決め直せる設定で、段階（ライフサイクル）を持たない",
  "anytime:clearOperationLimit": "範囲はユーザーがいつでも決め直せる設定で、段階（ライフサイクル）を持たない",
  "anytime:setLocalScope": "範囲はユーザーがいつでも決め直せる設定で、段階（ライフサイクル）を持たない",
  "unused-field:limits": "操作ごとの上限・ローカルの書き込みの範囲は、判断表「自動でやってよいか」で使う設定で、設定の操作の可否は変えない（同じ操作の上限が 1 つだけなことは、不変条件で確かめる）",
  "unused-field:localScope": "操作ごとの上限・ローカルの書き込みの範囲は、判断表「自動でやってよいか」で使う設定で、設定の操作の可否は変えない（同じ操作の上限が 1 つだけなことは、不変条件で確かめる）",
  "equivalent-states:ローカルの書き込み · limits=[] · worktree 内のファイル変更だけ/調べる · limits=[] · worktree 内のファイル変更だけ/外への書き込み（下書き） · limits=[] · worktree 内のファイル変更だけ/外への書き込み（本番） · limits=[] · worktree 内のファイル変更だけ/ローカルの書き込み · limits=[{ operation: github.issue_comment }] · worktree 内のファイル変更だけ/ローカルの書き込み · limits=[] · この PC の中ならどこでも/調べる · limits=[{ operation: github.issue_comment }] · worktree 内のファイル変更だけ/調べる · limits=[] · この PC の中ならどこでも/外への書き込み（下書き） · limits=[{ operation: github.issue_comment }] · worktree 内のファイル変更だけ/外への書き込み（下書き） · limits=[] · この PC の中ならどこでも/外への書き込み（本番） · limits=[{ operation: github.issue_comment }] · worktree 内のファイル変更だけ/外への書き込み（本番） · limits=[] · この PC の中ならどこでも/ローカルの書き込み · limits=[{ operation: github.issue_comment }] · この PC の中ならどこでも/調べる · limits=[{ operation: github.issue_comment }] · この PC の中ならどこでも/外への書き込み（下書き） · limits=[{ operation: github.issue_comment }] · この PC の中ならどこでも/外への書き込み（本番） · limits=[{ operation: github.issue_comment }] · この PC の中ならどこでも": "範囲の値が違っても、設定の操作（決め直す）は同じ。値の違いは、判断表「自動でやってよいか」の答えに出る",
};

export const scenarios = {
  "初めは、worktree 内のファイル変更までを自動でやる": [{ do: initial, by: "アプリ", expect: { defaultLimit: "ローカルの書き込み", localScope: "worktree 内のファイル変更だけ" } }],
  "issue へのコメントは本番まで、PR は下書きまで自動でやる": [
    { do: initial, by: "アプリ" },
    { do: setDefaultLimit, by: "ユーザー", input: "下書き", expect: { defaultLimit: "外への書き込み（下書き）" } },
    { do: setOperationLimit, by: "ユーザー", expect: { limits: [{ operation: "github.issue_comment", limit: "外への書き込み（本番）" }] } },
    { do: clearOperationLimit, by: "ユーザー", expect: { limits: [] } },
  ],
  "範囲を決めるのはユーザーだけ": [
    { do: initial, by: "アプリ" },
    { do: setDefaultLimit, by: "アプリ", input: "下書き", denied: "ユーザーだけ" },
    { do: setOperationLimit, by: "アプリ", denied: "ユーザーだけ" },
    { do: setLocalScope, by: "アプリ", input: "どこでも", denied: "ユーザーだけ" },
    { do: setLocalScope, by: "ユーザー", input: "どこでも", expect: { localScope: "この PC の中ならどこでも" } },
    { do: setLocalScope, by: "ユーザー", input: "worktree", expect: { localScope: "worktree 内のファイル変更だけ" } },
    { do: clearOperationLimit, by: "アプリ", denied: "ユーザーだけ" },
  ],
  "初めの範囲はアプリが用意する": [{ do: initial, by: "ユーザー", denied: "アプリだけ" }],
};
