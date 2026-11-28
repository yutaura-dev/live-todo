import type { AgentRun } from "./agent-run.spec.ts";
import type { AgentThread } from "./agent-thread.spec.ts";

/**
 * Task ごとの AI との会話と、そこで任せた作業。作業は会話を通してだけ扱い、同じ会話（session）で続ける。
 */
export const displayName = "Agent Thread";
export const root = "agent-thread";
export const entities = ["agent-run"];

const active = (run: AgentRun) => run.status === "やっている" || run.status === "判断中";

export const invariants = {
  "1 つの Task で、Claude Code が動いている作業は 1 つまで（同じ会話を同時に使わない）": (_thread: AgentThread, runs: ReadonlyArray<AgentRun>) => runs.filter(active).length <= 1,
  "続けられない会話では、Claude Code が動いている作業はない": (thread: AgentThread, runs: ReadonlyArray<AgentRun>) => thread.status === "続けられる" || !runs.some(active),
};
