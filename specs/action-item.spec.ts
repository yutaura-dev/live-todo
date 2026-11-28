import { ensure } from "@yutaura/live-spec";
import type { ActionDefinition } from "./action-definition.value.ts";

/**
 * Action Item（次にやること 1 つ）。Task の計画（plan）の中にあり、Task と一緒に扱う。
 * Action Item は、中身（definition: 何をするか・何によって果たされるか）と、進み具合（status・progress）からなる。中身は作ったあと変わらない。
 * いつ着手できる（番が来る）かは、Task の計画の中の位置で決まる。
 */
export type ActionItem = {
  /** 済んだか */
  status: ItemStatus;
  /** 中身。作ったあと変わらない */
  definition: ActionDefinition;
  /** 果たされ方ごとの進み具合 */
  progress: Progress;
  /** Action Item を見分ける ID（Task の中で） */
  id: string;
};

export const ItemStatus = {
  /** まだ */
  todo: "todo",
  /** 済んだ */
  done: "done",
  /** やらなくなった（分かれ道を選び直した・計画を立て直した・Task をやらないことにした） */
  skipped: "skipped",
} as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

/** 果たされ方ごとの進み具合。中身の果たされ方（definition.how.type）と同じ種類を持つ */
export type Progress =
  /** 進み具合を持たない（人・書き込みで果たされる） */
  | { type: "none" }
  /** Claude Code にやらせた進み具合 */
  | { type: "claude"; run: Run; report: string | null }
  /** 待つ条件を確かめた結果と、待ち始めた時刻 */
  | { type: "condition"; observed: "まだ" | "成り立った" | "達成できない"; waitingSince: string }
  /** 分かれ道で選んだか（何を選んだか・選び直した履歴は、Task の計画の枝に残る） */
  | { type: "decision"; chosen: "まだ" | "選んだ" };

export const Run = {
  /** まだやらせていない */
  none: "なし",
  /** Claude Code がやっている */
  running: "やっている",
  /** 一度やらせた。やり遂げたら報告を残して済ませる。できなかった・作業を止めた・アプリを閉じて止まったときは、報告だけ残して済ませない */
  ran: "動かした",
} as const;
export type Run = (typeof Run)[keyof typeof Run];

type Actor = { kind: "user" } | { kind: "sync" } | { kind: "agent" } | { kind: "scheduler" } | { kind: "app" };
/** 番が来ているか（Task の計画の中の位置で決まる） */
type Turn = "番が来ている" | "番待ち";
/** 選んだ枝で、AI が作業中か */
type BranchWork = "作業なし" | "作業中";

export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  同期: { kind: "sync" },
  AI: { kind: "agent" },
  定期の処理: { kind: "scheduler" },
  アプリ: { kind: "app" },
};

function progressFor(definition: ActionDefinition): Progress {
  if (definition.how.type === "claude") return { type: "claude", run: "なし", report: null };
  if (definition.how.type === "decision") return { type: "decision", chosen: "まだ" };
  if (definition.how.type === "condition") return { type: "condition", observed: "まだ", waitingSince: "2026-11-28T00:00:00Z" };
  return { type: "none" };
}

/**
 * Action Item を作る
 *
 * AI が計画を立てたとき、定期の Task をひな形から作ったとき、分かれ道で選んだ選択肢の先の計画が決まっていたとき（中身から作る）。
 */
export function initial(actor: Actor, definition: ActionDefinition): ActionItem {
  ensure(actor.kind === "agent" || actor.kind === "scheduler" || actor.kind === "user", "AI か定期の処理か、分かれ道を選んだユーザーだけ");
  return { status: "todo", definition, progress: progressFor(definition), id: "a1" };
}

const decision: ActionDefinition = {
  title: "修正してから merge するか決める",
  effort: "easy",
  completes: false,
  how: {
    type: "decision",
    question: "型エラーが出ている。直してから merge するか",
    options: [
      { label: "そのまま merge する", then: { type: "planned", plan: { type: "serial", items: [{ title: "merge する", effort: "easy", completes: false, how: { type: "write", subject: { uri: "github://yutaura@github.com/acme/app/pull/42" }, operation: "github.merge", params: { method: "squash" }, version: "abc1234", trigger: "on_request", place: null } }] } } },
      { label: "ひとまず調査する", then: { type: "planLater", direction: "型エラーの原因と影響範囲を調べる" } },
    ],
  },
};

export const inputs = {
  initial: {
    人がやる: [{ title: "年末調整の書類を出す", effort: "normal", completes: false, how: { type: "human", place: null } }],
    頼めばやる: [{ title: "型エラーを直して push する", effort: "normal", completes: false, how: { type: "claude", trigger: "on_request", workspace: null } }],
    自動でやる: [{ title: "変更点を読んでまとめる", effort: "easy", completes: false, how: { type: "claude", trigger: "auto", workspace: null } }],
    条件で果たす: [{ title: "PR が merge されるのを待つ", effort: "easy", completes: true, how: { type: "condition", condition: { subject: { uri: "github://yutaura@github.com/acme/app/pull/42" }, name: "github.merged", afterStart: false, label: "PR #42 が merge される" } } }],
    書き込みで果たす: [{ title: "merge する", effort: "easy", completes: false, how: { type: "write", subject: { uri: "github://yutaura@github.com/acme/app/pull/42" }, operation: "github.merge", params: { method: "squash" }, version: "abc1234", trigger: "on_request", place: null } }],
    分かれ道: [decision],
  },
  complete: { 番が来ている: ["番が来ている"], 番待ち: ["番待ち"] },
  finishByCondition: { 番が来ている: ["番が来ている"], 番待ち: ["番待ち"] },
  observeCondition: { 成り立った: ["成り立った"], 達成できない: ["達成できない"] },
  completeByWrite: { 番が来ている: ["番が来ている"], 番待ち: ["番待ち"] },
  autoStart: { 番が来ている: ["番が来ている"], 番待ち: ["番待ち"] },
  choose: { 番が来ている: ["番が来ている"], 番待ち: ["番待ち"] },
  rechoose: { 作業なし: ["作業なし"], 作業中: ["作業中"] },
};

const isRunning = (item: ActionItem) => item.progress.type === "claude" && item.progress.run === "やっている";

/** ユーザーが「済んだ」を押す（Claude Code が果たす Action Item も、自分で済ませてよい） */
export function complete(item: ActionItem, actor: Actor, turn: Turn): ActionItem {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(item.status === "todo", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.definition.how.type === "human" || item.definition.how.type === "claude", "人か Claude Code が果たす Action Item だけ");
  ensure(!isRunning(item), "Claude Code がやっている途中でないときだけ");
  return { ...item, status: "done" };
}

/**
 * 待つ条件を確かめた結果が出る（Watcher が見つける）
 *
 * 番が来ていなくても、成り立ったことは持っておく（番が来たときに果たすため）。見張る対象が消えて、もう成り立ちようがなければ「達成できない」にする。
 * 確かめても分からないときは、結果を出さない（「達成できない」にもしない）。
 */
export function observeCondition(item: ActionItem, actor: Actor, verdict: "成り立った" | "達成できない"): ActionItem {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(item.status === "todo", "まだのときだけ");
  ensure(item.progress.type === "condition" && item.progress.observed === "まだ", "待つ条件で、まだ結果が出ていないときだけ");
  return { ...item, progress: { ...item.progress, observed: verdict } };
}

/**
 * 待つ条件で果たされる
 *
 * 番が来ていて、待つ条件が成り立っていれば果たす（成り立ったときに番が来ていれば、すぐ。番待ちの間に成り立ったなら、番が来たとき）。
 */
export function finishByCondition(item: ActionItem, actor: Actor, turn: Turn): ActionItem {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(item.status === "todo", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.progress.type === "condition" && item.progress.observed === "成り立った", "待つ条件が成り立ったときだけ");
  return { ...item, status: "done" };
}

/** 待つ対象がまた現れた（ユーザーが確かめて戻した・関わっている対象の一覧にまた載った）ので、達成できないを取り消して、また待つ */
export function resetCondition(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(item.status === "todo", "まだのときだけ");
  ensure(item.progress.type === "condition" && item.progress.observed === "達成できない", "達成できないになったときだけ");
  return { ...item, progress: { ...item.progress, observed: "まだ" } };
}

/** 承認した書き込みが成功して果たされる（書き込みが、成功を知らせる） */
export function completeByWrite(item: ActionItem, actor: Actor, turn: Turn): ActionItem {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(item.status === "todo", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.definition.how.type === "write", "書き込みで果たされる Action Item だけ");
  return { ...item, status: "done" };
}

function withRun(item: ActionItem, run: Run, status: ItemStatus = item.status): ActionItem {
  if (item.progress.type !== "claude") return item;
  return { ...item, status, progress: { ...item.progress, run } };
}

/** Claude Code に頼む（Claude Code を使わない設定なら頼めない） */
export function request(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(item.status === "todo", "まだのときだけ");
  ensure(item.definition.how.type === "claude", "Claude Code が果たす Action Item だけ");
  ensure(!isRunning(item), "やっている途中でないときだけ");
  return withRun(item, "やっている");
}

/** Claude Code が自動で始める（1 分ごとに、1 回 3 件まで） */
export function autoStart(item: ActionItem, actor: Actor, turn: Turn): ActionItem {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(item.status === "todo", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.definition.how.type === "claude" && item.definition.how.trigger === "auto", "自動でやる Action Item だけ");
  ensure(item.progress.type === "claude" && item.progress.run === "なし", "一度も動かしていないときだけ");
  return withRun(item, "やっている");
}

/** Claude Code がやり遂げる */
export function succeed(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(isRunning(item), "やっているときだけ");
  return withRun(item, "動かした", "done");
}

/**
 * Claude Code の作業が終わる（済ませずに）
 *
 * できなかった・作業を止めた（画面で確かめてから止める）・追う Source Item が片付いて作業をやめた。
 */
export function stop(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "agent" || actor.kind === "user", "AI かユーザーだけ");
  ensure(isRunning(item), "やっているときだけ");
  return withRun(item, "動かした");
}

/** アプリを閉じて止まった作業を、起動したときにできなかったにする */
export function recover(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(isRunning(item), "やっているときだけ");
  return withRun(item, "動かした");
}

/**
 * 済んだ Action Item を戻す
 *
 * 戻せるのは、人か Claude Code が果たす Action Item だけ。Claude Code の報告は残り、自動ではもう動かさない（頼めばまたやる）。
 * 分かれ道は戻さずに選び直す。待つ条件・承認した書き込みで果たされたものは、外で起きたことなので戻さない。
 */
export function reopen(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(item.status === "done", "済んだときだけ");
  ensure(item.definition.how.type === "human" || item.definition.how.type === "claude", "人か Claude Code が果たす Action Item だけ");
  return { ...item, status: "todo" };
}

/**
 * 分かれ道で選ぶ
 *
 * 先の計画が決まっている選択肢なら、その中身から Action Item を作って差し込む。選んでから考える選択肢なら、AI にその方針で先の計画を考えさせる。
 */
export function choose(item: ActionItem, actor: Actor, turn: Turn): ActionItem {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(item.status === "todo", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.progress.type === "decision", "分かれ道だけ");
  return { ...item, status: "done", progress: { ...item.progress, chosen: "選んだ" } };
}

/**
 * 分かれ道で選び直す
 *
 * 前に選んだ枝は取りやめる。枝の中の済んだ Action Item は残し、まだのものはやらなくなる。新しく選んだ選択肢の先を差し込む。
 * 前に選んだ枝で AI が作業中なら、先に作業を止める（画面では、止めてよいかを確かめてから止める）。
 */
export function rechoose(item: ActionItem, actor: Actor, branchWork: BranchWork): ActionItem {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(item.progress.type === "decision" && item.progress.chosen === "選んだ", "選んだあとだけ");
  ensure(branchWork === "作業なし", "選んだ枝で AI が作業中でないときだけ");
  return { ...item, progress: { ...item.progress } };
}

/**
 * やらなくなる
 *
 * 分かれ道を選び直して枝を取りやめた・計画を立て直して外れた・Task をやらないことにした。
 */
export function skip(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "user" || actor.kind === "sync" || actor.kind === "agent", "ユーザーか同期か AI だけ");
  ensure(item.status === "todo", "まだのときだけ");
  ensure(!isRunning(item), "Claude Code がやっている途中でないときだけ");
  return { ...item, status: "skipped" };
}

export const invariants = {
  "中身は、作ったあと変わらない": (before: ActionItem, after: ActionItem) => JSON.stringify(before.definition) === JSON.stringify(after.definition),
  "進み具合の種類は、果たされ方と合っている": (item: ActionItem) =>
    item.progress.type === (item.definition.how.type === "claude" || item.definition.how.type === "decision" || item.definition.how.type === "condition" ? item.definition.how.type : "none"),
  "Claude Code がやっている途中の Action Item は、まだ": (item: ActionItem) => !isRunning(item) || item.status === "todo",
  "やらなくなった Action Item は、もう動かない": (before: ActionItem, after: ActionItem) => before.status !== "skipped" || JSON.stringify(before) === JSON.stringify(after),
};

export const reviewed = {
  "same-for-similar-actors:stop": "作業は、ユーザーが（画面で確かめてから）止めることも、AI ができなかった・追う Source Item が片付いてやめることもある",
  "same-for-similar-actors:skip": "やらなくなるのは、ユーザー（分かれ道の選び直し・Task を片付けた）、同期（Task を絞り込みの外にした）、AI（計画の立て直し）の、どの出来事からでも起きる",
};

export const links = [
  { from: complete, to: "task", action: "noteProgress", label: "Action Item が済んだことを、Task の出来事に残す" },
  { from: succeed, to: "task", action: "noteProgress", label: "Claude Code が Action Item を果たしたことを、Task の出来事に残す" },
  { from: finishByCondition, to: "task", action: "noteProgress", label: "待つ条件で Action Item が果たされたことを、Task の出来事に残す" },
  { from: completeByWrite, to: "task", action: "noteProgress", label: "書き込みで Action Item が果たされたことを、Task の出来事に残す" },
  { from: skip, to: "task", action: "noteProgress", label: "Action Item をやらないことにしたのを、Task の出来事に残す" },
  { from: reopen, to: "task", action: "noteProgress", label: "Action Item をやり直すことにしたのを、Task の出来事に残す" },
  { from: choose, to: "task", action: "noteProgress", label: "分かれ道を選んだことを、Task の出来事に残す" },
  { from: rechoose, to: "task", action: "noteProgress", label: "分かれ道を選び直したことを、Task の出来事に残す" },
  { from: rechoose, to: "completion-effect", action: "withdraw", label: "選び直したら、前の枝に置いていた完了したときにすることを取りやめる" },
  { from: complete, to: "task", action: "satisfyCompletion", label: "完了条件の Action Item で、ほかの完了条件もすべて満たしていれば、Task の完了条件を満たす" },
  { from: finishByCondition, to: "task", action: "satisfyCompletion", label: "完了条件の Action Item で、ほかの完了条件もすべて満たしていれば、Task の完了条件を満たす" },
  { from: completeByWrite, to: "task", action: "satisfyCompletion", label: "完了条件の Action Item で、ほかの完了条件もすべて満たしていれば、Task の完了条件を満たす" },
  { from: succeed, to: "task", action: "satisfyCompletion", label: "完了条件の Action Item で、ほかの完了条件もすべて満たしていれば、Task の完了条件を満たす" },
  { from: reopen, to: "task", action: "addPendingCriteria", label: "完了条件の Action Item なら、まだの完了条件ができる" },
  { from: reopen, to: "task", action: "reopen", label: "やり終えた Task なら、やり直す" },
  { from: choose, to: "task", action: "addPendingCriteria", label: "先の計画が決まっていれば、差し込む（その中の完了条件が、まだの完了条件になる）" },
  { from: choose, to: "task", action: "makeUndetermined", label: "選んでから考える選択肢なら、先の計画ができるまで完了条件は未定" },
  { from: choose, to: "task", action: "startWork", label: "選んでから考える選択肢なら、AI に先の計画を考えさせる" },
  { from: rechoose, to: "action-item", action: "skip", label: "前に選んだ枝の、まだの Action Item をやらなくする" },
  { from: rechoose, to: "task", action: "addPendingCriteria", label: "新しく選んだ選択肢の先を差し込む" },
  { from: request, to: "task", action: "startWork", label: "AI が作業中になる" },
  { from: observeCondition, to: "action-item", action: "finishByCondition", label: "成り立ったとき番が来ていれば、すぐ果たす" },
  { from: observeCondition, to: "watch-target", action: "removeWaiter", label: "結果が出たら（成り立った・達成できない）、その対象を待つのをやめる" },
  { from: observeCondition, to: "task", label: "達成できなくなったら、Task が受け取る（AI が計画を立て直すか、ユーザーに知らせる）" },
  { from: complete, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: succeed, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: completeByWrite, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: finishByCondition, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: choose, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: skip, to: "watch-target", action: "removeWaiter", label: "待つ条件の Action Item をやらなくなったら、その対象を待つのをやめる（まだ待っていたなら）" },
  { from: resetCondition, to: "watch-target", action: "addWaiter", label: "また待つので、その対象を待つ" },
  { from: skip, to: "write", action: "withdraw", label: "書き込みで果たされる Action Item をやらなくなったら、確認中の書き込みを取りやめる" },
  { to: "watch-target", action: "addWaiter", label: "待つ条件の Action Item を作ったら、その対象を待つ（見張っていなければ見張りを始める）" },
  { from: autoStart, to: "task", action: "startWork", label: "AI が作業中になる" },
];

export const scenarios = {
  "Action Item を作るのは、AI か定期の処理か、分かれ道を選んだユーザー": [{ do: initial, by: "同期", input: "人がやる", denied: "AI か定期の処理か、分かれ道を選んだユーザーだけ" }],
  "人が果たす Action Item は、番が来たら済ませられる": [
    { do: initial, by: "AI", input: "人がやる" },
    { do: complete, by: "ユーザー", input: "番待ち", denied: "番が来ているときだけ" },
    { do: choose, by: "ユーザー", input: "番が来ている", denied: "分かれ道だけ" },
    { do: completeByWrite, by: "アプリ", input: "番が来ている", denied: "書き込みで果たされる Action Item だけ" },
    { do: finishByCondition, by: "同期", input: "番が来ている", denied: "待つ条件が成り立ったときだけ" },
    { do: request, by: "ユーザー", denied: "Claude Code が果たす Action Item だけ" },
    { do: complete, by: "ユーザー", input: "番が来ている", expect: { status: "done" } },
    { do: reopen, by: "ユーザー", expect: { status: "todo" } },
  ],
  "分かれ道は、番が来たら選び、あとで選び直せる": [
    { do: initial, by: "AI", input: "分かれ道" },
    { do: complete, by: "ユーザー", input: "番が来ている", denied: "人か Claude Code が果たす Action Item だけ" },
    { do: rechoose, by: "ユーザー", input: "作業なし", denied: "選んだあとだけ" },
    { do: choose, by: "ユーザー", input: "番待ち", denied: "番が来ているときだけ" },
    { do: choose, by: "ユーザー", input: "番が来ている", expect: { status: "done" } },
    { do: reopen, by: "ユーザー", denied: "人か Claude Code が果たす Action Item だけ" },
    { do: rechoose, by: "ユーザー", input: "作業中", denied: "選んだ枝で AI が作業中でないときだけ" },
    { do: rechoose, by: "ユーザー", input: "作業なし", expect: { status: "done" } },
  ],
  "待つ条件で果たされる Action Item は、番待ちの間に成り立っても、番が来たら果たされる": [
    { do: initial, by: "定期の処理", input: "条件で果たす" },
    { do: finishByCondition, by: "同期", input: "番が来ている", denied: "待つ条件が成り立ったときだけ" },
    { do: observeCondition, by: "AI", input: "成り立った", denied: "同期だけ" },
    { do: observeCondition, by: "同期", input: "成り立った", expect: { status: "todo", progress: { observed: "成り立った" } } },
    { do: observeCondition, by: "同期", input: "達成できない", denied: "待つ条件で、まだ結果が出ていないときだけ" },
    { do: finishByCondition, by: "同期", input: "番待ち", denied: "番が来ているときだけ" },
    { do: finishByCondition, by: "同期", input: "番が来ている", expect: { status: "done" } },
  ],
  "待つ対象が消えたら、達成できないになり、Task が受け取る": [
    { do: initial, by: "AI", input: "条件で果たす" },
    { do: observeCondition, by: "同期", input: "達成できない", expect: { progress: { observed: "達成できない" } } },
    { do: finishByCondition, by: "同期", input: "番が来ている", denied: "待つ条件が成り立ったときだけ" },
    { do: skip, by: "AI", expect: { status: "skipped" } },
    { do: observeCondition, by: "同期", input: "成り立った", denied: "まだのときだけ" },
  ],
  "達成できないになっても、対象がまた現れたら、また待つ": [
    { do: initial, by: "AI", input: "条件で果たす" },
    { do: resetCondition, by: "同期", denied: "達成できないになったときだけ" },
    { do: observeCondition, by: "同期", input: "達成できない" },
    { do: resetCondition, by: "AI", denied: "同期だけ" },
    { do: resetCondition, by: "同期", expect: { progress: { observed: "まだ" } } },
    { do: observeCondition, by: "同期", input: "成り立った" },
    { do: finishByCondition, by: "同期", input: "番が来ている", expect: { status: "done" } },
    { do: reopen, by: "ユーザー", denied: "人か Claude Code が果たす Action Item だけ" },
  ],
  "書き込みで果たされる Action Item は、番が来て書き込めたら済む": [
    { do: initial, by: "AI", input: "書き込みで果たす" },
    { do: completeByWrite, by: "ユーザー", input: "番が来ている", denied: "アプリだけ" },
    { do: completeByWrite, by: "アプリ", input: "番待ち", denied: "番が来ているときだけ" },
    { do: completeByWrite, by: "アプリ", input: "番が来ている", expect: { status: "done" } },
  ],
  "自動でやる Action Item を、番が来たら一度だけ動かしてやり遂げる": [
    { do: initial, by: "AI", input: "自動でやる" },
    { do: autoStart, by: "AI", input: "番待ち", denied: "番が来ているときだけ" },
    { do: autoStart, by: "AI", input: "番が来ている" },
    { do: autoStart, by: "AI", input: "番が来ている", denied: "一度も動かしていないときだけ" },
    { do: request, by: "ユーザー", denied: "やっている途中でないときだけ" },
    { do: complete, by: "ユーザー", input: "番が来ている", denied: "Claude Code がやっている途中でないときだけ" },
    { do: skip, by: "ユーザー", denied: "Claude Code がやっている途中でないときだけ" },
    { do: succeed, by: "ユーザー", denied: "AI だけ" },
    { do: succeed, by: "AI", expect: { status: "done" } },
    { do: reopen, by: "ユーザー", expect: { status: "todo" } },
    { do: autoStart, by: "AI", input: "番が来ている", denied: "一度も動かしていないときだけ" },
  ],
  "頼めばやる Action Item は自動では動かず、止めたら頼み直せる": [
    { do: initial, by: "AI", input: "頼めばやる" },
    { do: autoStart, by: "AI", input: "番が来ている", denied: "自動でやる Action Item だけ" },
    { do: request, by: "ユーザー" },
    { do: stop, by: "同期", denied: "AI かユーザーだけ" },
    { do: stop, by: "ユーザー", expect: { status: "todo" } },
    { do: request, by: "ユーザー" },
    { do: recover, by: "ユーザー", denied: "アプリだけ" },
    { do: recover, by: "アプリ", expect: { status: "todo" } },
  ],
  "やらなくなった Action Item は、もう動かない": [
    { do: initial, by: "AI", input: "人がやる" },
    { do: skip, by: "アプリ", denied: "ユーザーか同期か AI だけ" },
    { do: skip, by: "AI", expect: { status: "skipped" } },
    { do: complete, by: "ユーザー", input: "番が来ている", denied: "まだのときだけ" },
    { do: reopen, by: "ユーザー", denied: "済んだときだけ" },
    { do: skip, by: "AI", denied: "まだのときだけ" },
  ],
  "操作は決まった人と段階でだけ起きる": [
    { do: initial, by: "AI", input: "人がやる" },
    { do: succeed, by: "AI", denied: "やっているときだけ" },
    { do: stop, by: "AI", denied: "やっているときだけ" },
    { do: recover, by: "アプリ", denied: "やっているときだけ" },
    { do: reopen, by: "ユーザー", denied: "済んだときだけ" },
    { do: complete, by: "AI", input: "番が来ている", denied: "ユーザーだけ" },
    { do: choose, by: "AI", input: "番が来ている", denied: "ユーザーだけ" },
    { do: rechoose, by: "AI", input: "作業なし", denied: "ユーザーだけ" },
    { do: finishByCondition, by: "AI", input: "番が来ている", denied: "同期だけ" },
    { do: request, by: "AI", denied: "ユーザーだけ" },
    { do: autoStart, by: "ユーザー", input: "番が来ている", denied: "AI だけ" },
    { do: complete, by: "ユーザー", input: "番が来ている" },
    { do: complete, by: "ユーザー", input: "番が来ている", denied: "まだのときだけ" },
    { do: choose, by: "ユーザー", input: "番が来ている", denied: "まだのときだけ" },
    { do: completeByWrite, by: "アプリ", input: "番が来ている", denied: "まだのときだけ" },
    { do: finishByCondition, by: "同期", input: "番が来ている", denied: "まだのときだけ" },
    { do: request, by: "ユーザー", denied: "まだのときだけ" },
    { do: autoStart, by: "AI", input: "番が来ている", denied: "まだのときだけ" },
    { do: reopen, by: "AI", denied: "ユーザーだけ" },
  ],
};
