import { ensure } from "@yutaura/live-spec";

/**
 * Agent Thread（Task ごとの AI との会話）。Task について頼んだ作業（Agent Run）を、同じ会話として続けるためのもの。
 * Claude Code の会話（session）は作業場所に結び付くので、続けるときは同じ場所で動かす。続けられなくなったら、次の作業で新しい会話を始める。
 * 会話は、Task の最初の作業を始めるときに作る。
 */
export type AgentThread = {
  /** 会話を続けられるか */
  status: Status;
  /** @ref task */
  taskId: string;
  /** どの AI か（今は Claude Code） */
  provider: string;
  /** 続けるための会話の ID */
  sessionId: string;
  /** 会話が結び付く作業場所 */
  workspace: string;
};

export const Status = {
  /** 同じ会話として続けられる */
  resumable: "続けられる",
  /** 作業場所が消えた・会話が切れた。次の作業で、新しい会話を始める */
  lost: "続けられない",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "app" } | { kind: "user" };

/** アプリ: Claude Code を起動し、会話を続けられるかを確かめる */
export const actors: Record<string, Actor> = {
  アプリ: { kind: "app" },
  ユーザー: { kind: "user" },
};

/**
 * 最初の作業で、会話を始める
 *
 * 会話の ID は先に決めて起動する。止めたあとも続けられるように。ADR-0016
 */
export function initial(actor: Actor): AgentThread {
  ensure(actor.kind === "app", "アプリだけ");
  return { status: "続けられる", taskId: "t1", provider: "claude-code", sessionId: "s1", workspace: "~/live-todo/work/t1" };
}

/** 続けられなくなった（作業場所が消えた・会話が切れた）。動いている作業があれば、先に止まったことにする */
export function lose(thread: AgentThread, actor: Actor, running: "動いている作業がない" | "動いている作業がある"): AgentThread {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(thread.status === "続けられる", "続けられるときだけ");
  ensure(running === "動いている作業がない", "動いている作業がないときだけ");
  return { ...thread, status: "続けられない" };
}

/** 新しい会話を始める（続けられないときの、次の作業で） */
export function renew(thread: AgentThread, actor: Actor): AgentThread {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(thread.status === "続けられない", "続けられないときだけ");
  return { ...thread, status: "続けられる", sessionId: "s2" };
}

export const inputs = { lose: { 動いていない: ["動いている作業がない"], 動いている: ["動いている作業がある"] } };

export const scenarios = {
  "作業場所が消えたら、次の作業で新しい会話を始める": [
    { do: initial, by: "アプリ", expect: { status: "続けられる" } },
    { do: renew, by: "アプリ", denied: "続けられないときだけ" },
    { do: lose, by: "ユーザー", input: "動いていない", denied: "アプリだけ" },
    { do: lose, by: "アプリ", input: "動いている", denied: "動いている作業がないときだけ" },
    { do: lose, by: "アプリ", input: "動いていない", expect: { status: "続けられない" } },
    { do: lose, by: "アプリ", input: "動いていない", denied: "続けられるときだけ" },
    { do: renew, by: "ユーザー", denied: "アプリだけ" },
    { do: renew, by: "アプリ", expect: { status: "続けられる" } },
  ],
  "会話を始めるのはアプリだけ": [{ do: initial, by: "ユーザー", denied: "アプリだけ" }],
};
