import { ensure } from "@yutaura/live-spec";

/**
 * LLM Profile（使う LLM のプロバイダ・モデル・認証情報の組み合わせ）。判定（Decisions）と、AI の作業（計画・会話・Claude Code）で使う。
 * 会社のデータは、会社が許可した LLM にだけ送る（charter の前提と制約）。会社のデータを送ってよいかは Profile ごとにユーザーが決め、会社のアカウントには、送ってよい Profile しか選べない。
 * どの Profile を使うかはアカウントごとに選び、選ばなければ既定の Profile を使う。会社のアカウントに許可されていない Profile を選べないことは、Account が守る（ここでは、会社のアカウントが使っている間に許可を外せないことを守る）。送る直前にももう一度確かめ、許可されていなければ送らずに要確認にする。
 * 認証情報（API キー）は .env.local に置き、renderer には渡さない。
 */
export type LlmProfile = {
  /** 使えるか */
  status: Status;
  /** 会社のデータを送ってよいか（会社が許可したプロバイダ・契約か）。ユーザーが決める */
  companyAllowed: boolean;
  /** Profile を見分ける名前 */
  id: string;
  /** プロバイダ（none: 使わない・anthropic・openai・gemini・azure-openai・bedrock）。使わないなら、規則で決まらないものはすべて要確認にする（どこにも送らないので、会社の許可は要らない） */
  provider: string;
  /** モデル（Azure OpenAI なら deployment の名前） */
  model: string;
  /** 確率付きの判定に使うプロバイダ（Decisions provider）と閾値。todo 以上なら todo、review 以上なら要確認 */
  decisions: { provider: DecisionsProvider; thresholds: { todo: number; review: number } } | null;
  /** 認証情報が通らなかった理由 */
  problem: Problem | null;
};

export type DecisionsProvider = "jev" | "openai" | "azure-openai" | "microsoft-decision" | "gemini";
export type Problem = "API キーが切れた" | "権限がない";

export const Status = {
  /** 使える */
  usable: "使える",
  /** 認証情報が通らない（API キーが切れた・権限がない）。直すまで、この Profile での判定と AI の作業は止め、判定は要確認に倒す。断られた（refusal）・回数の上限・ネットワークの失敗は、これにはせず、その回の判定だけ要確認にする */
  rejected: "認証が通らない",
  /** ユーザーが消した */
  removed: "消した",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "user" } | { kind: "app" };

/** アプリ: LLM を呼んで、認証情報が通らないことに気づく */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

/** Profile を作る（会社のデータを送ってよいかは、ユーザーが決める） */
export function initial(actor: Actor, companyAllowed: boolean): LlmProfile {
  ensure(actor.kind === "user", "ユーザーだけ");
  return {
    status: "使える",
    companyAllowed,
    id: companyAllowed ? "work" : "private",
    provider: "azure-openai",
    model: "gpt-5",
    decisions: { provider: "microsoft-decision", thresholds: { todo: 0.8, review: 0.5 } },
    problem: null,
  };
}

/**
 * 送り先（プロバイダ・モデル・判定のプロバイダ）を変える
 *
 * 会社のデータを送ってよいと決めたのは前の送り先なので、許可を外す（会社のアカウントが使っている間は、先にそのアカウントの Profile を替える）。変えた送り先で、認証情報を確かめて通ったときだけ変えられる。
 */
export function changeTarget(profile: LlmProfile, actor: Actor, usedByCompany: "会社のアカウントが使っている" | "使っていない", check: "通った" | "通らない"): LlmProfile {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(profile.status !== "消した", "消していないときだけ");
  ensure(!profile.companyAllowed || usedByCompany === "使っていない", "会社のアカウントが使っていないときだけ");
  ensure(check === "通った", "確かめて通ったときだけ");
  return { ...profile, status: "使える", companyAllowed: false, model: "gpt-5.1", problem: null };
}

/** 会社のデータを送ってよいことにする */
export function allowCompany(profile: LlmProfile, actor: Actor): LlmProfile {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(profile.status !== "消した", "消していないときだけ");
  ensure(!profile.companyAllowed, "会社のデータを送ってよいことになっていないときだけ");
  return { ...profile, companyAllowed: true };
}

/**
 * 会社のデータを送らないことにする
 *
 * 会社のアカウントがこの Profile を使っている間はできない（会社のデータを、許可されていない LLM に送ることになるため）。先に、そのアカウントの Profile を替える。
 */
export function disallowCompany(profile: LlmProfile, actor: Actor, usedByCompany: "会社のアカウントが使っている" | "使っていない"): LlmProfile {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(profile.status !== "消した", "消していないときだけ");
  ensure(profile.companyAllowed, "会社のデータを送ってよいことになっているときだけ");
  ensure(usedByCompany === "使っていない", "会社のアカウントが使っていないときだけ");
  return { ...profile, companyAllowed: false };
}

/** 認証情報が通らなかった（呼んだら断られた） */
export function reject(profile: LlmProfile, actor: Actor): LlmProfile {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(profile.status === "使える", "使えるときだけ");
  return { ...profile, status: "認証が通らない", problem: "API キーが切れた" };
}

/** 認証情報を直した（確かめて通ったときだけ） */
export function fix(profile: LlmProfile, actor: Actor, check: "通った" | "通らない"): LlmProfile {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(profile.status === "認証が通らない", "認証が通らないときだけ");
  ensure(check === "通った", "確かめて通ったときだけ");
  return { ...profile, status: "使える", problem: null };
}

/** 消す（どのアカウントも使っておらず、既定でもないときだけ） */
export function remove(profile: LlmProfile, actor: Actor, inUse: "使われている" | "使われていない"): LlmProfile {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(profile.status !== "消した", "消していないときだけ");
  ensure(inUse === "使われていない", "どのアカウントも使っておらず、既定でもないときだけ");
  return { ...profile, status: "消した", problem: null };
}

export const inputs = {
  initial: { 会社に許可された: [true], 私用だけ: [false] },
  disallowCompany: { 使っていない: ["使っていない"], 会社が使っている: ["会社のアカウントが使っている"] },
  fix: { 通った: ["通った"], 通らない: ["通らない"] },
  remove: { 使われていない: ["使われていない"], 使われている: ["使われている"] },
  changeTarget: { 使っていない: ["使っていない", "通った"], 会社が使っている: ["会社のアカウントが使っている", "通った"], 通らない: ["使っていない", "通らない"] },
};

export const invariants = {
  "消した Profile は、もう変わらない": (before: LlmProfile, after: LlmProfile) => before.status !== "消した" || after.status === "消した",
  "認証が通らないときだけ、理由がある": (profile: LlmProfile) => (profile.status === "認証が通らない") === (profile.problem !== null),
  "判定の閾値は 0〜1 で、要確認の閾値は todo の閾値以下": (profile: LlmProfile) =>
    profile.decisions === null ||
    (0 <= profile.decisions.thresholds.review && profile.decisions.thresholds.review <= profile.decisions.thresholds.todo && profile.decisions.thresholds.todo <= 1),
  "送り先が変わったら、会社のデータを送ってよい許可は外れる": (before: LlmProfile, after: LlmProfile) =>
    (before.provider === after.provider && before.model === after.model) || !after.companyAllowed,
};

export const links = [
  { from: reject, to: "task", label: "直すまで、この Profile を使う判定は要確認にし、AI の作業は始めない" },
];

export const scenarios = {
  "送り先を変えたら、会社のデータを送ってよいかを決め直す": [
    { do: initial, by: "ユーザー", input: "会社に許可された" },
    { do: changeTarget, by: "ユーザー", input: "会社が使っている", denied: "会社のアカウントが使っていないときだけ" },
    { do: changeTarget, by: "ユーザー", input: "通らない", denied: "確かめて通ったときだけ" },
    { do: changeTarget, by: "アプリ", input: "使っていない", denied: "ユーザーだけ" },
    { do: changeTarget, by: "ユーザー", input: "使っていない", expect: { companyAllowed: false } },
    { do: allowCompany, by: "ユーザー", expect: { companyAllowed: true } },
  ],
  "会社に許可された Profile を作り、会社のアカウントで使う": [
    { do: initial, by: "ユーザー", input: "会社に許可された", expect: { status: "使える", companyAllowed: true } },
    { do: disallowCompany, by: "ユーザー", input: "会社が使っている", denied: "会社のアカウントが使っていないときだけ" },
    { do: disallowCompany, by: "ユーザー", input: "使っていない", expect: { companyAllowed: false } },
    { do: allowCompany, by: "ユーザー", expect: { companyAllowed: true } },
    { do: allowCompany, by: "ユーザー", denied: "会社のデータを送ってよいことになっていないときだけ" },
  ],
  "API キーが切れたら、直すまで使わない": [
    { do: initial, by: "ユーザー", input: "私用だけ" },
    { do: reject, by: "ユーザー", denied: "アプリだけ" },
    { do: reject, by: "アプリ", expect: { status: "認証が通らない" } },
    { do: reject, by: "アプリ", denied: "使えるときだけ" },
    { do: fix, by: "ユーザー", input: "通らない", denied: "確かめて通ったときだけ" },
    { do: fix, by: "ユーザー", input: "通った", expect: { status: "使える", problem: null } },
    { do: fix, by: "ユーザー", input: "通った", denied: "認証が通らないときだけ" },
  ],
  "使われている Profile は消せない": [
    { do: initial, by: "ユーザー", input: "私用だけ" },
    { do: remove, by: "ユーザー", input: "使われている", denied: "どのアカウントも使っておらず、既定でもないときだけ" },
    { do: remove, by: "ユーザー", input: "使われていない", expect: { status: "消した" } },
    { do: remove, by: "ユーザー", input: "使われていない", denied: "消していないときだけ" },
    { do: allowCompany, by: "ユーザー", denied: "消していないときだけ" },
    { do: disallowCompany, by: "ユーザー", input: "使っていない", denied: "消していないときだけ" },
  ],
  "Profile を作るのはユーザーだけ": [{ do: initial, by: "アプリ", input: "私用だけ", denied: "ユーザーだけ" }],
  "会社のデータを送ってよいかを決めるのはユーザーだけ": [
    { do: initial, by: "ユーザー", input: "私用だけ" },
    { do: allowCompany, by: "アプリ", denied: "ユーザーだけ" },
    { do: disallowCompany, by: "ユーザー", input: "使っていない", denied: "会社のデータを送ってよいことになっているときだけ" },
    { do: allowCompany, by: "ユーザー" },
    { do: disallowCompany, by: "アプリ", input: "使っていない", denied: "ユーザーだけ" },
  ],
  "Profile を直す・消すのはユーザーだけ": [
    { do: initial, by: "ユーザー", input: "私用だけ" },
    { do: reject, by: "アプリ" },
    { do: fix, by: "アプリ", input: "通った", denied: "ユーザーだけ" },
    { do: remove, by: "アプリ", input: "使われていない", denied: "ユーザーだけ" },
  ],
};

export const questions = [
  {
    ask: "Claude Code は、どの Profile を選んでも Anthropic に送られる（ADR-0013）。会社のアカウントで Claude Code を使うと、許可された Profile を選んでいても、会社のデータが Anthropic に渡る。案 A: Claude Code を「claude-code」というプロバイダの Profile として扱い、会社の許可で縛る。案 B: Account に「Claude Code を使う」を持ち、会社のアカウントでは Claude Code が許可されているときだけ使えるようにする",
    about: allowCompany,
  },
  {
    ask: "会社のアカウントが Profile を選ばないと、許可されていない既定の Profile に落ちうる（今の実装は Microsoft のアカウントだけ禁じている）。案 A: 会社のアカウントは必ず Profile を明示して選ぶ。案 B: 既定が会社に許可されているときだけ既定に落ちる",
    about: disallowCompany,
  },
  {
    ask: "charter は「当面は 1 台の PC には会社用か私用か一方のデータだけを入れ、LLM Profile は PC 単位で 1 つ」としているが、今の実装はアカウントごとに Profile を選べる（なければ既定）。spec は実装に合わせてアカウントごとにした。charter の「将来はアカウントごとに切り替えられるようにする」を、もう今の形として charter を直してよいか？",
    about: initial,
  },
];

export const reviewed = {
  "unused-field:provider": "送り先（プロバイダ・モデル）は、送る先を決めるためのもので、操作の可否は変えない。送り先が変わったら許可が外れることを、不変条件で確かめるために読んでいる",
  "unused-field:model": "送り先（プロバイダ・モデル）は、送る先を決めるためのもので、操作の可否は変えない。送り先が変わったら許可が外れることを、不変条件で確かめるために読んでいる",
  "unused-field:decisions": "判定のプロバイダと閾値は、判定の仕方を決めるもので、操作の可否は変えない。閾値の範囲を、不変条件で確かめるために読んでいる",
};
