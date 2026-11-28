import { ensure } from "@yutaura/live-spec";

/**
 * AI の設定（PC に 1 つ）。アプリが使う AI を、使い道ごとに 3 つ持つ（中の AI Use）。3 つとも設定して確かめるまで、アプリは使えない。
 * 使い道は、安く簡単なものから順に上げていく。
 * - Decisions: 分類・確率付きの判定。コストが安い。まずこれを使う
 * - Generation: 文章を伴う Structured Output（Task の説明・計画を作る など）。Decisions でできないことに使う。Agent の成果物も入力にする
 * - Agent: 複雑な作業・調査（Claude Code・Codex・agy・OpenCode・pi code など）。Generationでできないことに使う。Task を直接は変えず、成果物をGenerationが受け取って Task の言葉にする
 * 3 つは独立して選べる（Decisions は OpenAI、Generationは Gemini、Agent は Claude Code、など）。
 * どれかの認証が通らなくなったら、アプリ全体を使えない状態にする（直すまで、同期・判定・AI の作業を止める）。
 * 会社の PC には会社が許可したものだけを設定する（charter の前提と制約: 1 台の PC には、会社用か私用か一方のデータだけを入れる）。認証情報（API キー）は .env.local に置き、renderer には渡さない。
 */
export type AiSettings = {
  /** アプリを使えるか */
  status: Status;
};

export const Status = {
  /** 3 つのどれかが、まだ設定されていない。アプリは使えない（設定の画面だけ出す） */
  setup: "初期設定中",
  /** 3 つとも設定して確かめた */
  ready: "使える",
  /** どれかの認証が通らない（API キーが切れた など）。直すまで、アプリ全体を使えない（設定の画面だけ出す） */
  suspended: "使えない",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "user" } | { kind: "app" };

/** アプリ: 3 つとも設定されたかを確かめる */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

/** アプリを初めて起動した（まだ何も設定していない） */
export function initial(actor: Actor): AiSettings {
  ensure(actor.kind === "app", "アプリだけ");
  return { status: "初期設定中" };
}

/** 3 つとも設定して確かめたので、アプリを使えるようにする */
export function finishSetup(settings: AiSettings, actor: Actor, uses: "3 つとも使える" | "まだ足りない"): AiSettings {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(settings.status === "初期設定中", "初期設定中のときだけ");
  ensure(uses === "3 つとも使える", "Decisions・Generation・Agent の 3 つとも、設定して確かめたときだけ");
  return { status: "使える" };
}

/** どれかの認証が通らなくなったので、アプリ全体を使えない状態にする */
export function suspend(settings: AiSettings, actor: Actor): AiSettings {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(settings.status === "使える", "使えるときだけ");
  return { status: "使えない" };
}

/** 認証が通らなかったものを直して、3 つとも使えるようになったので、また使えるようにする */
export function resume(settings: AiSettings, actor: Actor, uses: "3 つとも使える" | "まだ足りない"): AiSettings {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(settings.status === "使えない", "使えないときだけ");
  ensure(uses === "3 つとも使える", "Decisions・Generation・Agent の 3 つとも、設定して確かめたときだけ");
  return { status: "使える" };
}

export const inputs = {
  finishSetup: { そろった: ["3 つとも使える"], 足りない: ["まだ足りない"] },
  resume: { そろった: ["3 つとも使える"], 足りない: ["まだ足りない"] },
};

export const invariants = {
  "使えるようになったら、初期設定中には戻らない": (before: AiSettings, after: AiSettings) => before.status === "初期設定中" || after.status !== "初期設定中",
};

export const scenarios = {
  "3 つとも設定したら、アプリを使えるようになる": [
    { do: initial, by: "アプリ", expect: { status: "初期設定中" } },
    { do: finishSetup, by: "アプリ", input: "足りない", denied: "Decisions・Generation・Agent の 3 つとも、設定して確かめたときだけ" },
    { do: finishSetup, by: "ユーザー", input: "そろった", denied: "アプリだけ" },
    { do: finishSetup, by: "アプリ", input: "そろった", expect: { status: "使える" } },
    { do: finishSetup, by: "アプリ", input: "そろった", denied: "初期設定中のときだけ" },
  ],
  "どれかの認証が通らなくなったら、直すまでアプリ全体を使えない": [
    { do: initial, by: "アプリ" },
    { do: suspend, by: "アプリ", denied: "使えるときだけ" },
    { do: finishSetup, by: "アプリ", input: "そろった" },
    { do: suspend, by: "ユーザー", denied: "アプリだけ" },
    { do: suspend, by: "アプリ", expect: { status: "使えない" } },
    { do: resume, by: "アプリ", input: "足りない", denied: "Decisions・Generation・Agent の 3 つとも、設定して確かめたときだけ" },
    { do: resume, by: "ユーザー", input: "そろった", denied: "アプリだけ" },
    { do: resume, by: "アプリ", input: "そろった", expect: { status: "使える" } },
    { do: resume, by: "アプリ", input: "そろった", denied: "使えないときだけ" },
  ],
  "設定を始めるのはアプリだけ": [{ do: initial, by: "ユーザー", denied: "アプリだけ" }],
};

