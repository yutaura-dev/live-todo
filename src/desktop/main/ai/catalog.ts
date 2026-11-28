import type { AiUse, Choice } from "../../../domain/ai-settings/ai-settings.js";

/** 選べる AI 1 つ。キーは .env.local の LIVE_TODO_SECRET_<名前> で渡す（renderer には渡さない） */
export type AiOption = { id: string; label: string; choice: Choice; secret: string | null };

/** 会社の PC には、会社が許可したものだけを設定する（charter の前提と制約）。ここに足すのは、つなぐ実装があるものだけ */
export const AI_OPTIONS: Record<AiUse, ReadonlyArray<AiOption>> = {
  decisions: [{ id: "openai-decisions", label: "OpenAI Decisions（gpt-6-luna）", choice: { provider: "openai-decisions", model: "gpt-6-luna" }, secret: "LIVE_TODO_SECRET_LLM_OPENAI_API_KEY" }],
  generation: [
    { id: "claude-sonnet", label: "Claude Sonnet 5.5", choice: { provider: "anthropic", model: "claude-sonnet-5-5" }, secret: "LIVE_TODO_SECRET_LLM_ANTHROPIC_API_KEY" },
    { id: "claude-haiku", label: "Claude Haiku 5.5", choice: { provider: "anthropic", model: "claude-haiku-5-5" }, secret: "LIVE_TODO_SECRET_LLM_ANTHROPIC_API_KEY" },
    { id: "openai-gpt-mini", label: "OpenAI GPT-5 mini", choice: { provider: "openai", model: "gpt-5-mini" }, secret: "LIVE_TODO_SECRET_LLM_OPENAI_API_KEY" },
  ],
  agent: [{ id: "claude-code", label: "Claude Code", choice: { provider: "claude-code", model: null }, secret: null }],
};

export const optionOf = (use: AiUse, id: string) => AI_OPTIONS[use].find((option) => option.id === id);
export const optionFor = (use: AiUse, choice: Choice | null) =>
  choice === null ? undefined : AI_OPTIONS[use].find((option) => option.choice.provider === choice.provider && option.choice.model === choice.model);
