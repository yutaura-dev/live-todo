import { Effect, Schema } from "effect";
import { guard } from "../denied.js";

// specs/agent-thread.spec.ts の Agent Thread（Task ごとの AI との会話）。Task ごとに 1 つ（id は Task の id）

export const AgentThread = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["続けられる", "続けられない"]),
  provider: Schema.String,
  sessionId: Schema.String,
  workspace: Schema.String,
});
export type AgentThread = typeof AgentThread.Type;
export type ThreadActor = { readonly kind: "app" } | { readonly kind: "user" };

/** 会話の ID は先に決めて起動する（止めたあとも続けられるように。ADR-0016） */
export const openThread = Effect.fn("AgentThread.initial")(function* (actor: ThreadActor, content: { taskId: string; sessionId: string; workspace: string }) {
  yield* guard("agent-thread", "initial")(actor.kind === "app", "アプリだけ");
  const thread: AgentThread = { id: content.taskId, status: "続けられる", provider: "claude-code", sessionId: content.sessionId, workspace: content.workspace };
  return thread;
});

export const lose = Effect.fn("AgentThread.lose")(function* (thread: AgentThread, actor: ThreadActor, running: "動いている作業がない" | "動いている作業がある") {
  const ensure = guard("agent-thread", "lose");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(thread.status === "続けられる", "続けられるときだけ");
  yield* ensure(running === "動いている作業がない", "動いている作業がないときだけ");
  return { ...thread, status: "続けられない" as const };
});

export const renew = Effect.fn("AgentThread.renew")(function* (thread: AgentThread, actor: ThreadActor, sessionId: string) {
  const ensure = guard("agent-thread", "renew");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(thread.status === "続けられない", "続けられないときだけ");
  return { ...thread, status: "続けられる" as const, sessionId };
});
