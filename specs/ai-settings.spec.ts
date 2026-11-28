import { ensure } from "@yutaura/live-spec";

/**
 * AI Settings
 *
 * アプリが使う AI の設定。PC に 1 つ）。使い道ごとに 3 つを、独立して選ぶ（Decisions は OpenAI、Generation は Gemini、Agent は Claude Code、など）。
 * 3 つの違いは役割で、確かさの段ではない（Decisions で分からないことが、Generation に聞けば分かるわけではない）。どれを使うかは、Task が届いたものを受け取るところなど、使う側の判断表で決める（ADR-0022）。
 * - Decisions: 分類・確率付きの判定（安い）
 * - Generation: 文章を伴う Structured Output（Task の説明・計画を作る。Agent の成果物も入力にする）
 * - Agent: 複雑な作業・調査（Claude Code・Codex・agy・OpenCode・pi code など）。計画の中の Action Item から頼まれたときだけ動き、Task は直接変えない
 * 3 つとも設定して確かめるまで、アプリは使えない。どれかの認証が通らなくなったら、直すまでアプリ全体を使えない（同期・判定・AI の作業を止める）。
 * 会社の PC には、会社が許可したものだけを設定する（charter の前提と制約）。認証情報（API キー）は .env.local に置き、renderer には渡さない。
 * Decisions の閾値は固定で、判定ごとに決める（architecture.md）。設定には持たない。
 */
export type AiSettings = {
  /** アプリを使えるか */
  status: Status;
  /** 使い道ごとに、どれを使うか（まだ設定していなければ null） */
  uses: { decisions: Choice | null; generation: Choice | null; agent: Choice | null };
  /** 認証が通らないとき、どの使い道で・なぜか */
  problem: { use: "Decisions" | "Generation" | "Agent"; reason: "API キーが切れた" | "権限がない" } | null;
};

/** どれを使うか（Decisions・Generation ならプロバイダとモデル、Agent ならどの Agent か。形は provider が決める） */
export type Choice = { provider: string; model: string | null };

export const Status = {
  /** 3 つのどれかが、まだ設定されていない。アプリは使えない（設定の画面だけ出す） */
  setup: "初期設定中",
  /** 3 つとも設定して確かめた */
  ready: "使える",
  /** どれかの認証が通らない。直すまで、アプリ全体を使えない（設定の画面だけ出す） */
  suspended: "使えない",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "user" } | { kind: "app" };

/** アプリ: AI を呼んで、認証が通らないことに気づく */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

/** アプリを初めて起動した（まだ何も設定していない） */
export function initial(actor: Actor): AiSettings {
  ensure(actor.kind === "app", "アプリだけ");
  return { status: "初期設定中", uses: { decisions: null, generation: null, agent: null }, problem: null };
}

/**
 * 使い道を 1 つ設定する・選び直す・直す（どれを使うかを選び、認証を確かめて通ったときだけ）
 *
 * 3 つとも設定して確かめたら、アプリを使えるようにする。認証が通らなかった使い道を直したときも、使えるようにする。
 */
export function configure(settings: AiSettings, actor: Actor, use: "decisions" | "generation" | "agent", check: "通った" | "通らない"): AiSettings {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(check === "通った", "認証を確かめて通ったときだけ");
  const uses = { ...settings.uses, [use]: CHOICES[use] };
  const complete = uses.decisions !== null && uses.generation !== null && uses.agent !== null;
  if (!complete) return { ...settings, uses };
  return { status: "使える", uses, problem: null };
}

const CHOICES: Record<"decisions" | "generation" | "agent", Choice> = {
  decisions: { provider: "openai", model: "gpt-6-luna" },
  generation: { provider: "gemini", model: "gemini-3-pro" },
  agent: { provider: "claude-code", model: null },
};

/** 認証が通らなかった（呼んだら断られた）。直すまで、アプリ全体を使えない */
export function reject(settings: AiSettings, actor: Actor): AiSettings {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(settings.status === "使える", "使えるときだけ");
  return { ...settings, status: "使えない", problem: { use: "Decisions", reason: "API キーが切れた" } };
}

export const inputs = {
  configure: { Decisions: ["decisions", "通った"], Generation: ["generation", "通った"], Agent: ["agent", "通った"], 通らない: ["decisions", "通らない"] },
};

export const invariants = {
  "使えるようになったら、初期設定中には戻らない": (before: AiSettings, after: AiSettings) => before.status === "初期設定中" || after.status !== "初期設定中",
  "使えるのは、3 つとも設定してあるときだけ": (settings: AiSettings) => settings.status === "初期設定中" || (settings.uses.decisions !== null && settings.uses.generation !== null && settings.uses.agent !== null),
  "使えないときだけ、どの使い道でなぜかがある": (settings: AiSettings) => (settings.status === "使えない") === (settings.problem !== null),
};

export const reviewed = {
  "unused-field:uses": "どれを使うかは呼び出し先を決めるもので、操作の可否は変えない。3 つとも設定してあるときだけ使えることを、不変条件で確かめるために読んでいる",
  "anytime:configure": "どれを使うかは、いつでも選び直せる（初期設定中・使える・使えない のどれでも）。使えないときに直すのも、これで行う",
  "unused-field:problem": "どの使い道で・なぜ通らないかは、ユーザーに見せるもので、可否は変えない。使えないときだけあることを、不変条件で確かめるために読んでいる",
};

export const scenarios = {
  "3 つとも設定したら、アプリを使えるようになる": [
    { do: initial, by: "アプリ", expect: { status: "初期設定中" } },
    { do: configure, by: "ユーザー", input: "通らない", denied: "認証を確かめて通ったときだけ" },
    { do: configure, by: "アプリ", input: "Decisions", denied: "ユーザーだけ" },
    { do: configure, by: "ユーザー", input: "Decisions", expect: { status: "初期設定中" } },
    { do: reject, by: "アプリ", denied: "使えるときだけ" },
    { do: configure, by: "ユーザー", input: "Generation", expect: { status: "初期設定中" } },
    { do: configure, by: "ユーザー", input: "Agent", expect: { status: "使える" } },
  ],
  "どれかの認証が通らなくなったら、直すまでアプリ全体を使えない": [
    { do: initial, by: "アプリ" },
    { do: configure, by: "ユーザー", input: "Decisions" },
    { do: configure, by: "ユーザー", input: "Generation" },
    { do: configure, by: "ユーザー", input: "Agent" },
    { do: reject, by: "ユーザー", denied: "アプリだけ" },
    { do: reject, by: "アプリ", expect: { status: "使えない", problem: { use: "Decisions" } } },
    { do: reject, by: "アプリ", denied: "使えるときだけ" },
    { do: configure, by: "ユーザー", input: "Decisions", expect: { status: "使える", problem: null } },
  ],
  "設定を始めるのはアプリだけ": [{ do: initial, by: "ユーザー", denied: "アプリだけ" }],
};
