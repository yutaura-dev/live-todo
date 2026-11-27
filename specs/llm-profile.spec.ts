import { ensure } from "@yutaura/live-spec";

/**
 * LLM Profile（使う LLM のプロバイダ・モデル・認証情報の組み合わせ）。判定（Decisions）と、AI の作業（計画・会話・Claude Code）で使う。
 * 会社のデータは、会社が許可した LLM にだけ送る（charter の前提と制約）。会社のデータを送ってよいかは Profile ごとにユーザーが決め、会社のアカウントには、送ってよい Profile しか選べない。
 * どの Profile を使うかはアカウントごとに選び、選ばなければ既定の Profile を使う。認証情報（API キー）は .env.local に置き、renderer には渡さない。
 */
export type LlmProfile = {
  /** 使えるか */
  status: Status;
  /** 会社のデータを送ってよいか（会社が許可したプロバイダ・契約か）。ユーザーが決める */
  companyAllowed: boolean;
  /** Profile を見分ける名前 */
  id: string;
  /** プロバイダ（使わない・Anthropic・OpenAI・Gemini・Azure OpenAI・Bedrock）。使わないなら、規則で決まらないものはすべて要確認にする */
  provider: "none" | "anthropic" | "openai" | "gemini" | "azure-openai" | "bedrock";
  /** モデル（Azure OpenAI なら deployment の名前） */
  model: string;
  /** 確率付きの判定に使うプロバイダ（Decisions provider）と閾値 */
  decisions: { provider: string; thresholds: { todo: number; review: number } } | null;
  /** 認証情報が通らなかったときの理由 */
  problem: string | null;
};

export const Status = {
  /** 使える */
  usable: "使える",
  /** 認証情報が通らない（API キーが切れた・権限がない）。直すまで、この Profile での判定と AI の作業は止め、判定は要確認に倒す */
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
  return { ...profile, status: "認証が通らない", problem: "API キーが通らない" };
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
};

export const invariants = {
  "消した Profile は、もう変わらない": (before: LlmProfile, after: LlmProfile) => before.status !== "消した" || after.status === "消した",
  "認証が通らないときだけ、理由がある": (profile: LlmProfile) => (profile.status === "認証が通らない") === (profile.problem !== null),
};

export const scenarios = {
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
    ask: "charter は「当面は 1 台の PC には会社用か私用か一方のデータだけを入れ、LLM Profile は PC 単位で 1 つ」としているが、今の実装はアカウントごとに Profile を選べる（なければ既定）。spec は実装に合わせてアカウントごとにした。charter の「将来はアカウントごとに切り替えられるようにする」を、もう今の形として charter を直してよいか？",
    about: initial,
  },
];

export const reviewed = {
  "unused-field:problem": "通らなかった理由は、ユーザーに見せて直してもらうための記録で、操作の可否は変えない。認証が通らないときだけあることを、不変条件で確かめるために読んでいる",
};
