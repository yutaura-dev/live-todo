import { ensure } from "@yutaura/live-spec";

/**
 * 自動でやってよい範囲（Autonomy Policy。PC に 1 つ）。AI が、ユーザーに頼まれず・承認されずに、どこまで自動でやってよいかをユーザーが決める（ADR-0023）。
 * 操作を 4 つの段に分ける。provider が、自分の操作がどの段かを決め、段の違う書き込みは別の操作に分ける（draft の PR を作る github.pull_request.draft と、ready にする github.pull_request.ready など）。
 * 1. 調べる: 書き込みを伴わない調査（コードを読む・CI のログを見る・メールを検索する）
 * 2. ローカルの書き込み: worktree 内のファイル変更（パッケージのインストールを含む。ADR-0012 の sandbox が、書ける場所を worktree とパッケージのキャッシュに閉じ込める）
 * 3. 外への書き込み（下書き）: 外に書き込むが下書きにとどまるもの（draft の PR を作る・Gmail の下書きを作る）
 * 4. 外への書き込み（本番）: 外に本当に書き込むもの（issue にコメントする・PR を ready にする・メールを送る）
 * Agent の作業は 1 回の中で多くの操作をするので、渡す道具で段を決める。操作の名前は agent.read（読むだけ = 調べる）・agent.fix（直す = ローカルの書き込み）。
 * ユーザーは操作ごとに上限を決める（issue へのコメントは本番まで、PR は下書きまで など）。決めていない操作は、ローカルの書き込みまでを自動でやる（外への書き込みは、その操作の上限を決めたときだけ自動にする。新しく足された操作が、知らないうちに外に書き込まないように）。
 * 自動で書き込む先は、その Task が追っている事実そのもの（PR #42 へのコメント・そのスレッドへの返信の下書き など）に限る。「事実そのもの」とは、書き込む対象の URI が、その Task に tracks で紐づく Source Item の URI と一致することで、書き込みを頼んだ時点で確かめる。同じアカウントでも、ほかの対象（別のリポジトリの issue など）への書き込みは、範囲に入っていてもユーザーが承認する（読んだ内容に仕込まれた指示で、データを書き出さないように）。
 * 範囲に入るものは、計画の Action Item の番が来たら自動で始め、外への書き込みも確かめずに書き込む。ユーザーが範囲を決めたことを、その範囲の書き込みの承認とみなす。範囲に入らないものは、今までどおりユーザーが頼む・承認する。
 * 範囲を狭めたら、もう始めた作業・書き込み（Agent Run がやっている以降・Write が書き込み中以降）はそのまま続け、まだ始めていないもの（待ち行列の Agent Run）は狭めたあとの範囲で決め直し、入らなければ取り消す。
 */
export type AutonomyPolicy = {
  /** 操作ごとの上限（provider が決めた操作の名前と、上限） */
  limits: { operation: string; limit: Level }[];
};

export const Level = {
  /** 書き込みを伴わない調査 */
  read: "調べる",
  /** worktree 内のファイル変更 */
  local: "ローカルの書き込み",
  /** 外への書き込み（下書きまで） */
  draft: "外への書き込み（下書き）",
  /** 外への書き込み（本番） */
  live: "外への書き込み（本番）",
} as const;
export type Level = (typeof Level)[keyof typeof Level];

const ORDER: Level[] = ["調べる", "ローカルの書き込み", "外への書き込み（下書き）", "外への書き込み（本番）"];
/** 操作ごとの上限を決めていない操作の上限 */
const UNSET_LIMIT: Level = "ローカルの書き込み";

type Actor = { kind: "user" } | { kind: "app" };

export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

/** 初めの範囲（どの操作の上限も決めていない。ローカルの書き込みまでを自動でやる） */
export function initial(actor: Actor): AutonomyPolicy {
  ensure(actor.kind === "app", "アプリだけ");
  return { limits: [] };
}

/** 操作ごとの上限を決める（issue へのコメントは本番まで、など。同じ操作の上限は置き換える） */
export function setOperationLimit(policy: AutonomyPolicy, actor: Actor): AutonomyPolicy {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...policy, limits: [{ operation: "github.issue_comment", limit: "外への書き込み（本番）" }] };
}

/** 操作ごとの上限を外す（決めていない操作の扱いに戻す） */
export function clearOperationLimit(policy: AutonomyPolicy, actor: Actor): AutonomyPolicy {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...policy, limits: [] };
}

/** 自動でやってよいか（Action Item を自動で始めるか・外への書き込みを確かめずに書き込むかを、これで決める） */
function allowed(input: {
  "操作の段（Agent の作業なら、渡す道具で決まる段）": Level;
  その操作の上限: Level | "決めていない";
  書き込む先: "外に書き込まない" | "その Task の事実そのもの" | "ほかの対象（同じアカウントでも）";
}): "自動でやる" | "ユーザーが頼む・承認する" {
  const level = input["操作の段（Agent の作業なら、渡す道具で決まる段）"];
  const limit = input.その操作の上限 === "決めていない" ? UNSET_LIMIT : input.その操作の上限;
  if (ORDER.indexOf(level) > ORDER.indexOf(limit)) return "ユーザーが頼む・承認する";
  if (input.書き込む先 === "ほかの対象（同じアカウントでも）") return "ユーザーが頼む・承認する";
  return "自動でやる";
}

const L = "操作の段（Agent の作業なら、渡す道具で決まる段）" as const;

export const decisions = {
  自動でやってよいか: {
    decide: allowed,
    cases: [
      { input: { [L]: "調べる", その操作の上限: "決めていない", 書き込む先: "外に書き込まない" }, expect: "自動でやる" },
      { input: { [L]: "ローカルの書き込み", その操作の上限: "決めていない", 書き込む先: "外に書き込まない" }, expect: "自動でやる" },
      { input: { [L]: "外への書き込み（下書き）", その操作の上限: "決めていない", 書き込む先: "その Task の事実そのもの" }, expect: "ユーザーが頼む・承認する" },
      { input: { [L]: "外への書き込み（下書き）", その操作の上限: "外への書き込み（下書き）", 書き込む先: "その Task の事実そのもの" }, expect: "自動でやる" },
      { input: { [L]: "外への書き込み（本番）", その操作の上限: "外への書き込み（下書き）", 書き込む先: "その Task の事実そのもの" }, expect: "ユーザーが頼む・承認する" },
      { input: { [L]: "外への書き込み（本番）", その操作の上限: "外への書き込み（本番）", 書き込む先: "その Task の事実そのもの" }, expect: "自動でやる" },
      { input: { [L]: "外への書き込み（本番）", その操作の上限: "外への書き込み（本番）", 書き込む先: "ほかの対象（同じアカウントでも）" }, expect: "ユーザーが頼む・承認する" },
      { input: { [L]: "ローカルの書き込み", その操作の上限: "調べる", 書き込む先: "外に書き込まない" }, expect: "ユーザーが頼む・承認する" },
    ],
  },
};

export const invariants = {
  "同じ操作の上限は、1 つだけ": (policy: AutonomyPolicy) => new Set(policy.limits.map((limit) => limit.operation)).size === policy.limits.length,
};

export const reviewed = {
  "equivalent-states:limits=[]/limits=[{ operation: github.issue_comment }]": "上限の値が違っても、設定の操作（決め直す）は同じ。値の違いは、判断表「自動でやってよいか」の答えに出る",
  "anytime:setOperationLimit": "範囲はユーザーがいつでも決め直せる設定で、段階（ライフサイクル）を持たない",
  "anytime:clearOperationLimit": "範囲はユーザーがいつでも決め直せる設定で、段階（ライフサイクル）を持たない",
  "unused-field:limits": "操作ごとの上限は、判断表「自動でやってよいか」で使う設定で、設定の操作の可否は変えない（同じ操作の上限が 1 つだけなことは、不変条件で確かめる）",
};

export const scenarios = {
  "初めは、どの操作の上限も決めていない（ローカルの書き込みまでを自動でやる）": [{ do: initial, by: "アプリ", expect: { limits: [] } }],
  "issue へのコメントは本番まで自動でやる": [
    { do: initial, by: "アプリ" },
    { do: setOperationLimit, by: "ユーザー", expect: { limits: [{ operation: "github.issue_comment", limit: "外への書き込み（本番）" }] } },
    { do: clearOperationLimit, by: "ユーザー", expect: { limits: [] } },
  ],
  "範囲を決めるのはユーザーだけ": [
    { do: initial, by: "アプリ" },
    { do: setOperationLimit, by: "アプリ", denied: "ユーザーだけ" },
    { do: clearOperationLimit, by: "アプリ", denied: "ユーザーだけ" },
  ],
  "初めの範囲はアプリが用意する": [{ do: initial, by: "ユーザー", denied: "アプリだけ" }],
};
