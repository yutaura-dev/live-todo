import type { AiSettings } from "./ai-settings.spec.ts";
import type { AiUse } from "./ai-use.spec.ts";

/**
 * AI の設定と、その中の 3 つの使い道（Decisions・Generation・Agent）。使い道は AI の設定を通してだけ扱う。
 */
export const displayName = "AI Settings";
export const root = "ai-settings";
export const entities = ["ai-use"];

export const invariants = {
  "使い道は、Decisions・Generation・Agent の 3 つが 1 つずつある": (_settings: AiSettings, uses: ReadonlyArray<AiUse>) =>
    uses.length === 3 && new Set(uses.map((use) => use.kind)).size === 3,
  "アプリを使えるのは、3 つとも使えるときだけ（どれかの認証が通らなければ、アプリ全体を使えない）": (settings: AiSettings, uses: ReadonlyArray<AiUse>) =>
    settings.status !== "使える" || uses.every((use) => use.status === "使える"),
};
