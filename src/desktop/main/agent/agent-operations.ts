import type { Level } from "../../../domain/autonomy/autonomy-policy.js";

/** Claude Code の作業を、自動でやってよい範囲の操作として名指す（読むだけ = 調べる、直す = ローカルの書き込み。ADR-0023） */
export const AGENT_OPERATIONS: ReadonlyArray<{ name: string; label: string; level: Level; tools: "読むだけ" | "直す" }> = [
  { name: "claude-code.read", label: "Claude Code に調べさせる", level: "調べる", tools: "読むだけ" },
  { name: "claude-code.fix", label: "Claude Code に作業場所で直させる", level: "ローカルの書き込み", tools: "直す" },
];
