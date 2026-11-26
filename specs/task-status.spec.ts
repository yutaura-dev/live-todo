import { ensure } from "@yutaura/live-spec";

/**
 * Task の status。カンバンのどの列に出るかを決める。
 * 同期（追う Source Item の状態）、ユーザーの操作、次にやることの手順、AI の処理の 4 つが status を動かす。
 */
export type Task = {
  /** カンバンの列。「未作成」は Task がまだないことを表す、spec だけの値 */
  status: "未作成" | "todo" | "in_progress" | "done" | "needs_review" | "dismissed" | "archived" | "agent_running";
  /** tracks で追う Source Item があるか。同期で作った Task はあり、手動・定期で作った Task はなし */
  tracked: "あり" | "なし";
  /** AI の処理が終わったときに戻す status。処理中でなければ「なし」 */
  returnTo: "なし" | "todo" | "in_progress" | "done" | "needs_review" | "dismissed" | "archived";
};

type Status = Task["status"];
type Actor = { kind: "user" } | { kind: "sync" } | { kind: "agent" };

/** tracks で追う Source Item の状態をまとめたもの（未解決 → 解決済み → 消えた の順に見る） */
type TrackedStates = "未解決がある" | "解決済みだけ" | "消えただけ";
type ClosedStates = Exclude<TrackedStates, "未解決がある">;
type Verdict = "todo" | "needs_review" | "not_todo";
type MovableStatus = "needs_review" | "todo" | "in_progress" | "done" | "dismissed";
type ReturnTo = Exclude<Task["returnTo"], "なし">;

export const initial: Task = { status: "未作成", tracked: "なし", returnTo: "なし" };

export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  同期: { kind: "sync" },
  AI: { kind: "agent" },
};

export const glossary = {
  todo: "やること（Todo の列）",
  in_progress: "進めている",
  done: "完了",
  needs_review: "要確認。判定が割れた・refusal だった・todo ではないと判定された Task",
  dismissed: "片付けた。ユーザーが「自分の todo ではない」と決めた",
  archived: "追う Source Item がすべて消えた（removed）",
  agent_running: "処理中。AI（Claude Code）が裏で調べている間だけ置く",
};

const OPEN: ReadonlyArray<Status> = ["todo", "in_progress", "needs_review"];
const CLOSED: ReadonlyArray<Status> = ["done", "archived"];
const PLAN_DRIVEN: ReadonlyArray<Status> = ["todo", "in_progress", "done"];

/** 同期で Task を作る */
export function createBySync(task: Task, actor: Actor, verdict: Verdict): Task {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(task.status === "未作成", "まだ Task がないときだけ");
  const status = verdict === "todo" ? "todo" : "needs_review";
  return { status, tracked: "あり", returnTo: "なし" };
}

/** 手動・定期で Task を作る */
export function createByHand(task: Task, actor: Actor): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "未作成", "まだ Task がないときだけ");
  return { status: "todo", tracked: "なし", returnTo: "なし" };
}

/**
 * 追う Source Item の状態が変わる
 *
 * resolved / reopened / removed の Activity が起きたとき、追う Item 全体の状態から status を導き直す。
 */
export function reconcile(task: Task, actor: Actor, states: TrackedStates): Task {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(task.status !== "未作成", "Task があるときだけ");
  ensure(task.tracked === "あり", "追う Source Item があるときだけ");
  return { ...task, status: deriveStatus(task.status, states) };
}

function deriveStatus(current: Status, states: TrackedStates): Status {
  if (current === "dismissed") return current;
  if (states === "未解決がある") return CLOSED.includes(current) ? "todo" : current;
  if (states === "解決済みだけ") return OPEN.includes(current) || current === "archived" ? "done" : current;
  return OPEN.includes(current) ? "archived" : current;
}

/** 列を移す */
export function move(task: Task, actor: Actor, to: MovableStatus): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status !== "未作成", "Task があるときだけ");
  ensure(task.status !== "agent_running", "処理中でないときだけ");
  return { ...task, status: to };
}

/**
 * 次にやることの手順がすべて済む
 *
 * 手順を書き換えたとき（status を同時に指定しない更新）に、残りの手順がなければ完了にする。
 * todo・in_progress のときだけ動き、要確認・処理中・片付けた Task はそのまま。
 */
export function finishAllSteps(task: Task, actor: Actor): Task {
  ensure(actor.kind !== "sync", "ユーザーか AI だけ");
  ensure(task.status !== "未作成", "Task があるときだけ");
  return { ...task, status: PLAN_DRIVEN.includes(task.status) ? "done" : task.status };
}

/**
 * まだの手順ができる
 *
 * 完了した Task に未完了の手順ができたとき、ユーザーが戻したときだけ todo に戻す。
 */
export function reopenSteps(task: Task, actor: Actor): Task {
  ensure(actor.kind !== "sync", "ユーザーか AI だけ");
  ensure(task.status !== "未作成", "Task があるときだけ");
  return { ...task, status: task.status === "done" && actor.kind === "user" ? "todo" : task.status };
}

/**
 * AI の処理を始める
 *
 * 次にやることを考え直す・PR を直す・コンフリクトを直すなど。元の status を覚えて処理中に移す。
 */
export function startAgent(task: Task, actor: Actor): Task {
  ensure(actor.kind !== "sync", "ユーザーか AI だけ");
  ensure(task.status !== "未作成", "Task があるときだけ");
  ensure(task.status !== "agent_running", "処理中でないときだけ");
  return { ...task, status: "agent_running", returnTo: task.status as ReturnTo };
}

/**
 * 知らせを受けて AI が作業をやめる
 *
 * 処理中に追う項目が merge・close された（または消えた）と同期が知らせると、Claude Code を止め、
 * 同じ会話で続ける意味があるかを判断させる。やめると判断したら、追う項目から status を導き直す。
 * 続けると判断したら、そのまま作業を終えて「AI の処理が終わる」になる。
 */
export function stopAgent(task: Task, actor: Actor, states: ClosedStates): Task {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(task.status === "agent_running", "処理中のときだけ");
  return { ...task, status: deriveStatus(task.returnTo === "なし" ? "todo" : task.returnTo, states), returnTo: "なし" };
}

/**
 * 待ち行列の処理を取り消す
 *
 * 処理中の Task の処理がまだ待ち行列にあるだけ（Claude Code が動いていない）なら、判断させずに取り消し、追う項目から status を導き直す。
 */
export function cancelQueued(task: Task, actor: Actor, states: ClosedStates): Task {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(task.status === "agent_running", "処理中のときだけ");
  return { ...task, status: deriveStatus(task.returnTo === "なし" ? "todo" : task.returnTo, states), returnTo: "なし" };
}

/** AI の処理が終わる */
export function finishAgent(task: Task, actor: Actor): Task {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(task.status === "agent_running", "処理中のときだけ");
  return { ...task, status: task.returnTo === "なし" ? "todo" : task.returnTo, returnTo: "なし" };
}

export const inputs = {
  createBySync: { todo: ["todo"], 要確認: ["needs_review"], todoではない: ["not_todo"] },
  reconcile: { 未解決がある: ["未解決がある"], 解決済みだけ: ["解決済みだけ"], 消えただけ: ["消えただけ"] },
  stopAgent: { mergeされた: ["解決済みだけ"], 消えた: ["消えただけ"] },
  cancelQueued: { mergeされた: ["解決済みだけ"], 消えた: ["消えただけ"] },
  move: { 要確認へ: ["needs_review"], todoへ: ["todo"], 進行中へ: ["in_progress"], 完了へ: ["done"], 片付ける: ["dismissed"] },
};

export const invariants = {
  "処理中のときだけ戻す先を覚えている": (task: Task) => (task.status === "agent_running") === (task.returnTo !== "なし"),
};

export const scenarios = {
  "同期で作った Task が、PR の merge で完了する": [
    { do: createBySync, by: "同期", input: "todo", expect: { status: "todo" } },
    { do: reconcile, by: "同期", input: "解決済みだけ", expect: { status: "done" } },
  ],
  "完了した Task が、再オープンで todo に戻る": [
    { do: createBySync, by: "同期", input: "todo" },
    { do: reconcile, by: "同期", input: "解決済みだけ", expect: { status: "done" } },
    { do: reconcile, by: "同期", input: "未解決がある", expect: { status: "todo" } },
  ],
  "片付けた Task は、同期で戻らない": [
    { do: createBySync, by: "同期", input: "todoではない", expect: { status: "needs_review" } },
    { do: move, by: "ユーザー", input: "片付ける", expect: { status: "dismissed" } },
    { do: reconcile, by: "同期", input: "未解決がある", expect: { status: "dismissed" } },
  ],
  "手動の Task は同期で動かない": [
    { do: createByHand, by: "ユーザー", expect: { status: "todo" } },
    { do: reconcile, by: "同期", input: "解決済みだけ", denied: "追う Source Item があるときだけ" },
  ],
  "AI の処理が終わると元の列に戻る": [
    { do: createByHand, by: "ユーザー" },
    { do: move, by: "ユーザー", input: "進行中へ" },
    { do: startAgent, by: "ユーザー", expect: { status: "agent_running" } },
    { do: startAgent, by: "AI", denied: "処理中でないときだけ" },
    { do: move, by: "ユーザー", input: "完了へ", denied: "処理中でないときだけ" },
    { do: finishAgent, by: "AI", expect: { status: "in_progress" } },
  ],
  "操作はそれぞれ決まった人だけが起こし、Task がないと何もできない": [
    { do: createBySync, by: "ユーザー", input: "todo", denied: "同期だけ" },
    { do: createByHand, by: "同期", denied: "ユーザーだけ" },
    { do: move, by: "ユーザー", input: "todoへ", denied: "Task があるときだけ" },
    { do: finishAllSteps, by: "ユーザー", denied: "Task があるときだけ" },
    { do: reopenSteps, by: "ユーザー", denied: "Task があるときだけ" },
    { do: startAgent, by: "ユーザー", denied: "Task があるときだけ" },
    { do: finishAgent, by: "AI", denied: "処理中のときだけ" },
    { do: stopAgent, by: "AI", input: "mergeされた", denied: "処理中のときだけ" },
    { do: cancelQueued, by: "同期", input: "mergeされた", denied: "処理中のときだけ" },
    { do: createBySync, by: "同期", input: "todo" },
    { do: createBySync, by: "同期", input: "todo", denied: "まだ Task がないときだけ" },
    { do: createByHand, by: "ユーザー", denied: "まだ Task がないときだけ" },
    { do: reconcile, by: "ユーザー", input: "解決済みだけ", denied: "同期だけ" },
    { do: move, by: "同期", input: "完了へ", denied: "ユーザーだけ" },
    { do: finishAllSteps, by: "同期", denied: "ユーザーか AI だけ" },
    { do: reopenSteps, by: "同期", denied: "ユーザーか AI だけ" },
    { do: startAgent, by: "同期", denied: "ユーザーか AI だけ" },
    { do: startAgent, by: "AI" },
    { do: finishAgent, by: "ユーザー", denied: "AI だけ" },
    { do: stopAgent, by: "ユーザー", input: "mergeされた", denied: "AI だけ" },
    { do: cancelQueued, by: "ユーザー", input: "mergeされた", denied: "同期だけ" },
  ],
  "要確認の Task は、手順が済んでも完了にならない": [
    { do: createBySync, by: "同期", input: "要確認" },
    { do: finishAllSteps, by: "AI", expect: { status: "needs_review" } },
  ],
  "処理中に PR が merge され、AI が作業をやめると完了になる": [
    { do: createBySync, by: "同期", input: "todo" },
    { do: startAgent, by: "AI", expect: { status: "agent_running" } },
    { do: reconcile, by: "同期", input: "解決済みだけ", expect: { status: "agent_running" } },
    { do: stopAgent, by: "AI", input: "mergeされた", expect: { status: "done" } },
  ],
  "処理中に PR が merge されても、AI が続けると判断したら元の列に戻る": [
    { do: createBySync, by: "同期", input: "todo" },
    { do: startAgent, by: "AI" },
    { do: reconcile, by: "同期", input: "解決済みだけ", expect: { status: "agent_running" } },
    { do: finishAgent, by: "AI", expect: { status: "todo" } },
  ],
  "AI が手順を足しても、完了の Task は戻らない": [
    { do: createByHand, by: "ユーザー" },
    { do: finishAllSteps, by: "ユーザー", expect: { status: "done" } },
    { do: reopenSteps, by: "AI", expect: { status: "done" } },
    { do: reopenSteps, by: "ユーザー", expect: { status: "todo" } },
  ],
};

export const reviewed = {
  "untested:createBySync:同期だけ": "誰が起こすかは呼び出し口で決まる。Task を作る triage は同期の処理からしか呼ばれず、実装に権限の判定はないので、テストで確かめるものがない",
  "untested:createByHand:ユーザーだけ": "手で Task を作る addTask は画面の操作からしか呼ばれず、実装に権限の判定はない",
  "untested:createByHand:まだ Task がないときだけ": "「未作成」は spec だけの値。手で作る操作は毎回新しい Task を作る",
  "untested:reconcile:同期だけ": "status を導き直すのは同期の処理だけで、画面からは呼べない。実装に権限の判定はない",
  "untested:move:ユーザーだけ": "列を移す moveTask は画面の操作（IPC）からしか呼ばれず、実装に権限の判定はない",
  "untested:finishAllSteps:ユーザーか AI だけ": "手順を書き換えるのは画面の操作と AI の処理だけで、同期は手順を書き換えない。実装に権限の判定はない",
  "untested:finishAllSteps:Task があるときだけ": "「未作成」は spec だけの値。手順の操作は既にある Task の id を受け取る",
  "untested:reopenSteps:ユーザーか AI だけ": "手順を書き換えるのは画面の操作と AI の処理だけ。誰が戻したかで結果が変わることは、シナリオ「AI が手順を足しても、完了の Task は戻らない」と task-repository のテストで確かめている",
  "untested:reopenSteps:Task があるときだけ": "「未作成」は spec だけの値。手順の操作は既にある Task の id を受け取る",
  "untested:startAgent:ユーザーか AI だけ": "AI の処理を始めるのは画面の操作と定期の処理だけで、同期は始めない。実装に権限の判定はない",
  "untested:startAgent:Task があるときだけ": "「未作成」は spec だけの値。処理を始める操作は既にある Task の id を受け取る",
  "untested:stopAgent:AI だけ": "作業をやめるかを決めるのは Claude Code の回答だけで、画面や同期からは呼べない",
  "untested:cancelQueued:同期だけ": "待ち行列を取り消すのは同期が追う項目の変化を見つけたときだけで、画面からは呼べない",
  "untested:finishAgent:AI だけ": "処理を終えるのは AI の処理の後片付けだけで、画面や同期からは呼べない",
  "indistinguishable-example:createBySync:要確認,todoではない": "todo ではないと判定しても、判定の当たり具合を確かめるまでは隠さずに要確認にする",
  "same-for-similar-actors:finishAllSteps": "手順を済ませたのがユーザーでも AI でも、残りがなければ完了にする",
  "same-for-similar-actors:reopenSteps": "できるかどうかは同じで、違うのは結果だけ（完了から todo に戻すのはユーザーが戻したときだけ）。シナリオ「AI が手順を足しても、完了の Task は戻らない」で確かめている",
  "same-for-similar-actors:startAgent": "処理はユーザーの依頼（PR を直す・考え直すなど）でも、定期の処理（依存の更新の調査など）でも始まる",
  "unused-field:returnTo": "戻す先はできるかどうかには効かず、処理が終わったときの行き先だけを決める。シナリオ「AI の処理が終わると元の列に戻る」で確かめている",
};
