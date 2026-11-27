import { ensure } from "@yutaura/live-spec";

/**
 * AI の処理 1 回分（次にやることを考え直す・PR を直す・コンフリクトを直す・手順をやる・質問に答える・依存の更新を調べる・merge する）。
 * 処理の間、Task は処理中の列にいる（task-status）。処理中に追う項目が片付いたら、Claude Code にやめるか続けるかを判断させる。
 */
export type AgentRun = {
  /** 処理の段階。「未開始」は処理がまだないことを表す、spec だけの値 */
  stage: "未開始" | "待ち" | "実行中" | "判断中" | "続行中" | "終わった" | "やめた" | "失敗" | "取り消した";
  /** merge の処理か。merge は merge 自体が目的なので、追う項目が片付いたという知らせを受けない */
  kind: "merge" | "それ以外";
};

type Actor = { kind: "user" } | { kind: "sync" } | { kind: "agent" };
type Kind = AgentRun["kind"];

export const initial: AgentRun = { stage: "未開始", kind: "それ以外" };

export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  同期: { kind: "sync" },
  AI: { kind: "agent" },
};

export const glossary = {
  待ち: "待ち行列にあり、Claude Code はまだ動いていない（次にやることの考え直し・依存の更新の調査）",
  実行中: "Claude Code が作業している",
  判断中: "追う項目が片付いたので Claude Code を止め、同じ会話で、作業をやめるか続けるかを判断させている",
  続行中: "続けると判断して、同じ会話のまま作業を終わらせている。ここではもう知らせを受けない",
  やめた: "続ける意味がないと判断した。Task は追う項目から導いた列（merge なら完了）に戻る",
  取り消した: "待ち行列にあるだけだったので、判断させずに取り消した。Task は追う項目から導いた列に戻る",
};

/**
 * 待ち行列に入れる
 *
 * 次にやることを考え直す（ユーザーの依頼）・依存の更新を調べる（定期の処理）は、まず待ち行列に入る。
 */
export function enqueue(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind !== "sync", "ユーザーか AI だけ");
  ensure(run.stage === "未開始", "まだ処理がないときだけ");
  return { stage: "待ち", kind: "それ以外" };
}

/**
 * すぐに始める
 *
 * PR を直す・コンフリクトを直す・手順をやる・質問に答える・merge するは、待ち行列を通さずにすぐ始める。
 */
export function startNow(run: AgentRun, actor: Actor, kind: Kind): AgentRun {
  ensure(actor.kind !== "sync", "ユーザーか AI だけ");
  ensure(run.stage === "未開始", "まだ処理がないときだけ");
  return { stage: "実行中", kind };
}

/** 待ち行列から始める */
export function begin(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(run.stage === "待ち", "待ちのときだけ");
  return { ...run, stage: "実行中" };
}

/**
 * 追う項目が片付いたと知らせる
 *
 * 同期が、処理中の Task の追う項目がすべて merge・close された（または消えた）のを見つけたときに知らせる。
 * 待ちなら取り消し、実行中なら Claude Code を止めて判断させる。
 */
export function notifyClosed(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(run.kind !== "merge", "merge の処理には知らせない");
  ensure(run.stage === "待ち" || run.stage === "実行中", "待ちか実行中のときだけ");
  return { ...run, stage: run.stage === "待ち" ? "取り消した" : "判断中" };
}

/** やめると判断する */
export function decideStop(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(run.stage === "判断中", "判断中のときだけ");
  return { ...run, stage: "やめた" };
}

/** 続けると判断する */
export function decideContinue(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(run.stage === "判断中", "判断中のときだけ");
  return { ...run, stage: "続行中" };
}

/** 作業を終える */
export function finish(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(run.stage === "実行中" || run.stage === "続行中", "実行中か続行中のときだけ");
  return { ...run, stage: "終わった" };
}

/**
 * 失敗する
 *
 * 判断を頼んだのに決まった形の答えが返らなかったときも、失敗にする。
 */
export function fail(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(run.stage === "実行中" || run.stage === "判断中" || run.stage === "続行中", "動いているときだけ");
  return { ...run, stage: "失敗" };
}

export const inputs = {
  startNow: { PRを直すなど: ["それ以外"], merge: ["merge"] },
};

export const links = [
  { from: enqueue, to: "task-status", action: "startAgent", label: "Task を処理中にする" },
  { from: startNow, to: "task-status", action: "startAgent", label: "Task を処理中にする" },
  { from: finish, to: "task-status", action: "leaveAgent", label: "処理前の列に戻す" },
  { from: fail, to: "task-status", action: "leaveAgent", label: "処理前の列に戻す" },
  { from: decideStop, to: "task-status", action: "leaveAgent", label: "追う項目から導いた列に戻す（merge なら完了）" },
  { from: notifyClosed, to: "task-status", action: "leaveAgent", label: "待ちを取り消したら、追う項目から導いた列に戻す" },
];

export const scenarios = {
  "処理中に PR が merge され、Claude Code がやめると判断する": [
    { do: startNow, by: "ユーザー", input: "PRを直すなど", expect: { stage: "実行中" } },
    { do: notifyClosed, by: "同期", expect: { stage: "判断中" } },
    { do: decideStop, by: "AI", expect: { stage: "やめた" } },
  ],
  "処理中に PR が merge されても、続けると判断したら最後まで作業する": [
    { do: startNow, by: "ユーザー", input: "PRを直すなど" },
    { do: notifyClosed, by: "同期", expect: { stage: "判断中" } },
    { do: decideContinue, by: "AI", expect: { stage: "続行中" } },
    { do: notifyClosed, by: "同期", denied: "待ちか実行中のときだけ" },
    { do: finish, by: "AI", expect: { stage: "終わった" } },
  ],
  "待ち行列にあるだけなら、判断させずに取り消す": [
    { do: enqueue, by: "ユーザー", expect: { stage: "待ち" } },
    { do: notifyClosed, by: "同期", expect: { stage: "取り消した" } },
    { do: begin, by: "AI", denied: "待ちのときだけ" },
  ],
  "merge の処理には、merge されたことを知らせない": [
    { do: startNow, by: "ユーザー", input: "merge" },
    { do: notifyClosed, by: "同期", denied: "merge の処理には知らせない" },
    { do: finish, by: "AI", expect: { stage: "終わった" } },
  ],
  "操作は決まった人と段階でだけ起きる": [
    { do: begin, by: "AI", denied: "待ちのときだけ" },
    { do: decideStop, by: "AI", denied: "判断中のときだけ" },
    { do: decideContinue, by: "AI", denied: "判断中のときだけ" },
    { do: finish, by: "AI", denied: "実行中か続行中のときだけ" },
    { do: fail, by: "AI", denied: "動いているときだけ" },
    { do: enqueue, by: "同期", denied: "ユーザーか AI だけ" },
    { do: startNow, by: "同期", input: "PRを直すなど", denied: "ユーザーか AI だけ" },
    { do: enqueue, by: "ユーザー", expect: { stage: "待ち" } },
    { do: enqueue, by: "ユーザー", denied: "まだ処理がないときだけ" },
    { do: startNow, by: "ユーザー", input: "PRを直すなど", denied: "まだ処理がないときだけ" },
    { do: begin, by: "ユーザー", denied: "AI だけ" },
    { do: notifyClosed, by: "ユーザー", denied: "同期だけ" },
    { do: begin, by: "AI" },
    { do: finish, by: "ユーザー", denied: "AI だけ" },
    { do: fail, by: "ユーザー", denied: "AI だけ" },
    { do: notifyClosed, by: "同期", expect: { stage: "判断中" } },
    { do: decideStop, by: "ユーザー", denied: "AI だけ" },
    { do: decideContinue, by: "ユーザー", denied: "AI だけ" },
    { do: decideStop, by: "AI", expect: { stage: "やめた" } },
  ],
  "判断の答えが返らなければ、失敗にする": [
    { do: enqueue, by: "AI" },
    { do: begin, by: "AI", expect: { stage: "実行中" } },
    { do: notifyClosed, by: "同期" },
    { do: fail, by: "AI", expect: { stage: "失敗" } },
  ],
};

export const reviewed = {
  "untested:enqueue:ユーザーか AI だけ": "待ち行列に入れるのは画面の操作（考え直す）と定期の処理（依存の更新の調査）だけで、同期は入れない。実装に権限の判定はない",
  "untested:startNow:ユーザーか AI だけ": "すぐに始めるのは画面の操作と、自動でやる手順を進める処理だけで、同期は始めない。実装に権限の判定はない",
  "untested:begin:AI だけ": "待ち行列から取り出して始めるのは、AI の処理の順番待ちだけ。画面からは呼べない",
  "untested:notifyClosed:同期だけ": "追う項目が片付いたと知らせるのは、追う項目の状態を取り込む同期だけ。画面からは呼べない",
  "untested:decideStop:AI だけ": "やめるかどうかは Claude Code が答える。アプリは答えを読むだけで、ユーザーが決める画面はない",
  "untested:decideContinue:AI だけ": "続けるかどうかは Claude Code が答える。アプリは答えを読むだけで、ユーザーが決める画面はない",
  "untested:finish:AI だけ": "作業を終えるのは Claude Code の回答が返ったときだけ。画面から終わらせる操作はない",
  "untested:fail:AI だけ": "失敗は Claude Code の処理の結果として起きる。画面から失敗にする操作はない",
  "same-for-similar-actors:enqueue": "待ち行列には、ユーザーの依頼（考え直す）でも定期の処理（依存の更新の調査）でも入る",
  "same-for-similar-actors:startNow": "すぐに始める処理は、ユーザーの依頼（PR を直すなど）でも定期の処理（自動でやる手順）でも始まる",
};
