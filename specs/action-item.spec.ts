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
  todo: "まだ",
  /** 済んだ */
  done: "済んだ",
  /** やらなくなった（分かれ道を選び直した・計画を立て直した・Task をやらないことにした） */
  skipped: "やらなくなった",
} as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

/** 果たされ方ごとの進み具合。中身の果たされ方（definition.how.type）と同じ種類を持つ */
export type Progress =
  /** 進み具合を持たない（人・書き込みで果たされる） */
  | { type: "none" }
  /** Claude Code にやらせた進み具合 */
  | { type: "claude"; agentRunId: string | null }
  /** 待つ条件を確かめた結果と、待ち始めた時刻 */
  | { type: "condition"; observed: "まだ" | "成り立った" | "達成できない"; waitingSince: string }
  /** 分かれ道で選んだか（何を選んだか・選び直した履歴は、Task の計画の枝に残る） */
  | { type: "decision"; chosen: "まだ" | "選んだ" };


type Actor = { kind: "user" } | { kind: "sync" } | { kind: "agent" } | { kind: "scheduler" } | { kind: "app" };
/** 番が来ているか（Task の計画の中の位置で決まる） */
type Turn = "番が来ている" | "番待ち";
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  同期: { kind: "sync" },
  AI: { kind: "agent" },
  定期の処理: { kind: "scheduler" },
  アプリ: { kind: "app" },
};

function progressFor(definition: ActionDefinition): Progress {
  if (definition.how.type === "claude") return { type: "claude", agentRunId: null };
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
  return { status: "まだ", definition, progress: progressFor(definition), id: "a1" };
}

const decision: ActionDefinition = {
  title: "修正してから merge するか決める",
  effort: "easy", due: null,
  completes: false,
  how: {
    type: "decision",
    kind: "選ぶ",
    howToCheck: null,
    question: "型エラーが出ている。直してから merge するか",
    recommendation: null,
    options: [
      { label: "そのまま merge する", gains: [{ aspect: "期日", detail: "今日中にリリースできる" }], costs: [{ aspect: "確実さ", detail: "型エラーが本番で問題になるかもしれない" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [{ title: "merge する", effort: "easy", due: null, completes: false, how: { type: "write", subject: { uri: "github://yutaura@github.com/acme/app/pull/42" }, operation: "github.merge", params: { method: "squash" }, version: "abc1234", trigger: "on_request", place: null } }] } } },
      { label: "ひとまず調査する", gains: [{ aspect: "確実さ", detail: "影響が分かってから決められる" }], costs: [{ aspect: "期日", detail: "merge が 1 日ほど遅れる" }], unclear: [], then: { type: "planLater", direction: "型エラーの原因と影響範囲を調べる" } },
    ],
  },
};

export const inputs = {
  autoRequestWrite: { 番が来ている: ["番が来ている"], 番待ち: ["番待ち"] },
  initial: {
    人がやる: [{ title: "年末調整の書類を出す", effort: "normal", due: null, completes: false, how: { type: "human", place: null } }],
    頼めばやる: [{ title: "型エラーを直す", effort: "normal", due: null, completes: false, how: { type: "claude", trigger: "on_request", workspace: null, tools: "直す", subject: null } }],
    自動でやる: [{ title: "変更点を読んでまとめる", effort: "easy", due: null, completes: false, how: { type: "claude", trigger: "auto", workspace: null, tools: "読むだけ", subject: null } }],
    条件で果たす: [{ title: "PR が merge されるのを待つ", effort: "easy", due: null, completes: true, how: { type: "condition", condition: { subject: { uri: "github://yutaura@github.com/acme/app/pull/42" }, name: "github.merged", afterStart: false, label: "PR #42 が merge される" }, expectedWait: { text: "2〜3 営業日でレビューすると言われている", minDays: 2, maxDays: 3, businessDays: true } } }],
    書き込みで果たす: [{ title: "merge する", effort: "easy", due: null, completes: false, how: { type: "write", subject: { uri: "github://yutaura@github.com/acme/app/pull/42" }, operation: "github.merge", params: { method: "squash" }, version: "abc1234", trigger: "on_request", place: null } }],
    自動で書き込む: [{ title: "issue にコメントする", effort: "easy", due: null, completes: false, how: { type: "write", subject: { uri: "github://yutaura@github.com/acme/app/issues/12" }, operation: "github.comment", params: { body: "直しました" }, version: null, trigger: "auto", place: null } }],
    分かれ道: [decision],
  },
  complete: { 番が来ている: ["番が来ている"], 番待ち: ["番待ち"] },
  finishByCondition: { 番が来ている: ["番が来ている", "今も成り立つ"], 番待ち: ["番待ち", "今も成り立つ"] , 崩れた: ["番が来ている", "崩れた"] },
  observeCondition: { 成り立った: ["成り立った"], 達成できない: ["達成できない"] },
  completeByWrite: { 番が来ている: ["番が来ている"], 番待ち: ["番待ち"] },
  autoStart: { 番が来ている: ["番が来ている", "範囲に入る", "やること"], 番待ち: ["番待ち", "範囲に入る", "やること"], 範囲に入らない: ["番が来ている", "範囲に入らない", "やること"], 完了待ち: ["番が来ている", "範囲に入る", "やることでない"] },
  request: { 終わっている: ["終わっていない作業はない", "開いている"], 終わっていない: ["終わっていない作業がある", "開いている"], 完了待ち: ["終わっていない作業はない", "開いていない"] },
  succeed: { 番が来ている: ["番が来ている", "やり遂げた", "頼んだときのまま"], 番待ち: ["番待ち", "やり遂げた", "頼んだときのまま"], まだやり遂げていない: ["番が来ている", "まだやり遂げていない", "頼んだときのまま"], 元の項目が変わった: ["番が来ている", "やり遂げた", "変わった"] },
  choose: { 番が来ている: ["番が来ている"], 番待ち: ["番待ち"] },
};

/** ユーザーが「済んだ」を押す（Claude Code が果たす Action Item も、自分で済ませてよい） */
export function complete(item: ActionItem, actor: Actor, turn: Turn): ActionItem {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(item.status === "まだ", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.definition.how.type === "human" || item.definition.how.type === "claude", "人か Claude Code が果たす Action Item だけ");
  return { ...item, status: "済んだ" };
}

/**
 * 待つ条件を確かめた結果が出る（Watcher が見つける）
 *
 * 番が来ていなくても、成り立ったことは持っておく（番が来たときに果たすため）。見張る対象が消えて、もう成り立ちようがなければ「達成できない」にする。
 * 確かめても分からないときは、結果を出さない（「達成できない」にもしない）。
 */
export function observeCondition(item: ActionItem, actor: Actor, verdict: "成り立った" | "達成できない"): ActionItem {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(item.status === "まだ", "まだのときだけ");
  ensure(item.progress.type === "condition" && item.progress.observed === "まだ", "待つ条件で、まだ結果が出ていないときだけ");
  return { ...item, progress: { ...item.progress, observed: verdict } };
}

/**
 * 待つ条件で果たされる
 *
 * 番が来ていて、待つ条件が成り立っていれば果たす（成り立ったときに番が来ていれば、すぐ。番待ちの間に成り立ったなら、番が来たときに、今も成り立つかを確かめ直してから。崩れていたら resetCondition で待ち直す）。
 */
export function finishByCondition(item: ActionItem, actor: Actor, turn: Turn, still: "今も成り立つ" | "崩れた"): ActionItem {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(item.status === "まだ", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.progress.type === "condition" && item.progress.observed === "成り立った", "待つ条件が成り立ったときだけ");
  ensure(still === "今も成り立つ", "今も成り立っているときだけ（番待ちの間に崩れたら、待ち直す）");
  return { ...item, status: "済んだ" };
}

/** 待つ対象がまた現れた（ユーザーが確かめて戻した・関わっている対象の一覧にまた載った）ので、達成できないを取り消して、また待つ */
export function resetCondition(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(item.status === "まだ", "まだのときだけ");
  ensure(item.progress.type === "condition" && item.progress.observed === "達成できない", "達成できないになったときだけ");
  return { ...item, progress: { ...item.progress, observed: "まだ" } };
}

/** 承認した書き込みが成功して果たされる（書き込みが、成功を知らせる） */
export function completeByWrite(item: ActionItem, actor: Actor, turn: Turn): ActionItem {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(item.status === "まだ", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.definition.how.type === "write", "書き込みで果たされる Action Item だけ");
  return { ...item, status: "済んだ" };
}

/**
 * Claude Code に頼む（ボタンで）
 *
 * Agent Thread に作業（Agent Run）を頼み、その ID を持つ。作業がやっているか・止まったか・成果は Agent Run が持ち、Action Item は持たない（同じことを 2 か所で持たないため）。渡す道具（読むだけ・直す）は、Action Item の中身が決める。
 */
export function request(item: ActionItem, actor: Actor, running: "終わっていない作業はない" | "終わっていない作業がある", task: "開いている" | "開いていない"): ActionItem {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(item.status === "まだ", "まだのときだけ");
  ensure(item.definition.how.type === "claude", "Claude Code が果たす Action Item だけ");
  ensure(running === "終わっていない作業はない", "この Action Item の作業が終わっているときだけ（待ち行列も含む）");
  ensure(task === "開いている", "Task がやること のときだけ（完了待ちの Task では頼まない）");
  return item.progress.type === "claude" ? { ...item, progress: { ...item.progress, agentRunId: "ar1" } } : item;
}

/**
 * 番が来たので、自動で Claude Code に頼む
 *
 * 自動でやる Action Item で、自動でやってよい範囲に入る作業だけ。一度だけ
 */
export function autoStart(item: ActionItem, actor: Actor, turn: Turn, policy: "範囲に入る" | "範囲に入らない", task: "やること" | "やることでない"): ActionItem {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(item.status === "まだ", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.definition.how.type === "claude" && item.definition.how.trigger === "auto", "自動でやる Action Item だけ");
  ensure(item.progress.type === "claude" && item.progress.agentRunId === null, "一度も頼んでいないときだけ");
  ensure(policy === "範囲に入る", "自動でやってよい範囲に入る作業だけ（入らなければ、ボタンで頼むまで待つ）");
  ensure(task === "やること", "Task がやること のときだけ（完了待ちでは、自動で頼まない）");
  return { ...item, progress: { ...item.progress, agentRunId: "ar1" } };
}

/**
 * Claude Code がやり遂げた作業で、Action Item を果たす（Agent Run がやり遂げたとき、または番が来たとき）
 *
 * 元の項目は、Action Item の中身が名指しする項目（subject）。名指ししない（null）なら、いつも頼んだときのままとして受け取る。
 * ボタンでは、番が来る前でも頼める（ユーザーが先に進めたいときのため）。ただし、果たすのは番が来てから（やり遂げた成果は Agent Run に残り、番が来たら果たす）。
 */
/**
 * 番が来たので、自動で書き込みを頼む
 *
 * 書き込みで果たされる、自動でやる Action Item だけ。頼めるか・範囲に入るかは Write が確かめる
 */
export function autoRequestWrite(item: ActionItem, actor: Actor, turn: Turn): ActionItem {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(item.status === "まだ", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.definition.how.type === "write" && item.definition.how.trigger === "auto", "書き込みで果たされる、自動でやる Action Item だけ");
  return item;
}

export function succeed(item: ActionItem, actor: Actor, turn: Turn, run: "やり遂げた" | "まだやり遂げていない", subject: "頼んだときのまま" | "変わった"): ActionItem {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(item.status === "まだ", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ（番が来る前にやり遂げたら、番が来るまで待つ）");
  ensure(item.progress.type === "claude" && item.progress.agentRunId !== null, "Claude Code に頼んだ Action Item だけ");
  ensure(run === "やり遂げた", "頼んだ作業がやり遂げたときだけ");
  ensure(subject === "頼んだときのまま", "頼んだときから元の項目（PR の commit など）が変わっていないときだけ（変わっていたら果たさず、もう一度頼むよう見せる）");
  return { ...item, status: "済んだ" };
}

/**
 * 済んだ Action Item を戻す
 *
 * 戻せるのは、人か Claude Code が果たす Action Item だけ。Claude Code の報告は残り、自動ではもう動かさない（頼めばまたやる）。
 * 分かれ道は戻さずに選び直す。待つ条件・承認した書き込みで果たされたものは、外で起きたことなので戻さない。
 */
export function reopen(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(item.status === "済んだ", "済んだときだけ");
  ensure(item.definition.how.type === "human" || item.definition.how.type === "claude", "人か Claude Code が果たす Action Item だけ");
  return { ...item, status: "まだ" };
}

/**
 * 分かれ道で選ぶ
 *
 * 先の計画が決まっている選択肢なら、その中身から Action Item を作って差し込む。選んでから考える選択肢なら、AI にその方針で先の計画を考えさせる。
 */
export function choose(item: ActionItem, actor: Actor, turn: Turn): ActionItem {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(item.status === "まだ", "まだのときだけ");
  ensure(turn === "番が来ている", "番が来ているときだけ");
  ensure(item.progress.type === "decision", "分かれ道だけ");
  return { ...item, status: "済んだ", progress: { ...item.progress, chosen: "選んだ" } };
}

/**
 * 分かれ道で選び直す
 *
 * 前に選んだ枝は取りやめる。枝の中の済んだ Action Item は残し、まだのものはやらなくなる。新しく選んだ選択肢の先を差し込む。
 * 前に選んだ枝で AI が作業中でも選び直せる。画面では「作業を止めますか」と確かめ、選び直したらアプリが作業をやめる（理由はやらなくなった）。
 */
export function rechoose(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(item.progress.type === "decision" && item.progress.chosen === "選んだ", "選んだあとだけ");
  return { ...item, progress: { ...item.progress } };
}

/**
 * やらなくなる
 *
 * 分かれ道を選び直して枝を取りやめた・計画を立て直して外れた・Task をやらないことにした。
 */
export function skip(item: ActionItem, actor: Actor): ActionItem {
  ensure(actor.kind === "user" || actor.kind === "sync" || actor.kind === "agent", "ユーザーか同期か AI だけ");
  ensure(item.status === "まだ", "まだのときだけ");
  return { ...item, status: "やらなくなった" };
}

export const invariants = {
  "中身は、作ったあと変わらない": (before: ActionItem, after: ActionItem) => JSON.stringify(before.definition) === JSON.stringify(after.definition),
  "進み具合の種類は、果たされ方と合っている": (item: ActionItem) =>
    item.progress.type === (item.definition.how.type === "claude" || item.definition.how.type === "decision" || item.definition.how.type === "condition" ? item.definition.how.type : "none"),
  "やらなくなった Action Item は、もう動かない": (before: ActionItem, after: ActionItem) => before.status !== "やらなくなった" || JSON.stringify(before) === JSON.stringify(after),
};

export const reviewed = {
  "same-for-similar-actors:skip": "やらなくなるのは、ユーザー（分かれ道の選び直し・Task を片付けた）、同期（Task を絞り込みの外にした）、AI（計画の立て直し）の、どの出来事からでも起きる",
};

export const links = [
  { from: autoRequestWrite, to: "write", label: "自動で書き込みを頼む（Write が、自動でやってよい範囲・Task がやること か・版・1 回だけを確かめる。入らなければユーザーが頼むまで待つ）" },
  { from: complete, to: "agent-thread", label: "この Action Item の作業が終わっていなければ、アプリがやめる（理由はユーザーが済ませた。待ち行列なら取り消す）" },
  { from: skip, to: "agent-thread", label: "この Action Item の作業が終わっていなければ、アプリがやめる（理由はやらなくなった。待ち行列なら取り消す）" },
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
  { from: choose, to: "task", action: "revisePlan", label: "選んでから考える選択肢なら、Generation が先の計画を考える（AI の作業にはしない）" },
  { from: rechoose, to: "action-item", action: "skip", label: "前に選んだ枝の、まだの Action Item をやらなくする" },
  { from: rechoose, to: "task", action: "addPendingCriteria", label: "新しく選んだ選択肢の先を差し込む" },
  { from: request, to: "agent-thread", label: "Claude Code に、この Action Item をやる作業を頼む（作業を始めたら、Task が AI の作業中になる）" },
  { from: observeCondition, to: "action-item", action: "finishByCondition", label: "成り立ったとき番が来ていれば、すぐ果たす" },
  { from: observeCondition, to: "watch-target", action: "removeWaiter", label: "結果が出たら（成り立った・達成できない）、その対象を待つのをやめる" },
  { from: observeCondition, to: "task", action: "receive", label: "達成できなくなったら、「待つ条件が達成できない」として Task が受け取る（Generation が計画を立て直すか、ユーザーに知らせる）" },
  { from: complete, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: complete, to: "action-item", action: "autoStart", label: "次の Action Item に番が来て、自動でやる Action Item なら、Claude Code に頼む" },
  { from: complete, to: "action-item", action: "autoRequestWrite", label: "次の Action Item に番が来て、自動でやる書き込みの Action Item なら、書き込みを頼む" },
  { from: complete, to: "action-item", action: "succeed", label: "次の Action Item に番が来て、頼んだ Claude Code の作業がもうやり遂げていれば果たす" },
  { from: succeed, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: succeed, to: "action-item", action: "autoStart", label: "次の Action Item に番が来て、自動でやる Action Item なら、Claude Code に頼む" },
  { from: succeed, to: "action-item", action: "autoRequestWrite", label: "次の Action Item に番が来て、自動でやる書き込みの Action Item なら、書き込みを頼む" },
  { from: succeed, to: "action-item", action: "succeed", label: "次の Action Item に番が来て、頼んだ Claude Code の作業がもうやり遂げていれば果たす" },
  { from: completeByWrite, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: completeByWrite, to: "action-item", action: "autoStart", label: "次の Action Item に番が来て、自動でやる Action Item なら、Claude Code に頼む" },
  { from: completeByWrite, to: "action-item", action: "autoRequestWrite", label: "次の Action Item に番が来て、自動でやる書き込みの Action Item なら、書き込みを頼む" },
  { from: completeByWrite, to: "action-item", action: "succeed", label: "次の Action Item に番が来て、頼んだ Claude Code の作業がもうやり遂げていれば果たす" },
  { from: skip, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: skip, to: "action-item", action: "autoStart", label: "次の Action Item に番が来て、自動でやる Action Item なら、Claude Code に頼む" },
  { from: skip, to: "action-item", action: "autoRequestWrite", label: "次の Action Item に番が来て、自動でやる書き込みの Action Item なら、書き込みを頼む" },
  { from: skip, to: "action-item", action: "succeed", label: "次の Action Item に番が来て、頼んだ Claude Code の作業がもうやり遂げていれば果たす" },
  { from: finishByCondition, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: finishByCondition, to: "action-item", action: "autoStart", label: "次の Action Item に番が来て、自動でやる Action Item なら、Claude Code に頼む" },
  { from: finishByCondition, to: "action-item", action: "autoRequestWrite", label: "次の Action Item に番が来て、自動でやる書き込みの Action Item なら、書き込みを頼む" },
  { from: finishByCondition, to: "action-item", action: "succeed", label: "次の Action Item に番が来て、頼んだ Claude Code の作業がもうやり遂げていれば果たす" },
  { from: choose, to: "action-item", action: "finishByCondition", label: "次の Action Item に番が来て、その待つ条件がもう成り立っていれば果たす" },
  { from: choose, to: "action-item", action: "autoStart", label: "次の Action Item に番が来て、自動でやる Action Item なら、Claude Code に頼む" },
  { from: choose, to: "action-item", action: "autoRequestWrite", label: "次の Action Item に番が来て、自動でやる書き込みの Action Item なら、書き込みを頼む" },
  { from: choose, to: "action-item", action: "succeed", label: "次の Action Item に番が来て、頼んだ Claude Code の作業がもうやり遂げていれば果たす" },
  { from: skip, to: "watch-target", action: "removeWaiter", label: "待つ条件の Action Item をやらなくなったら、その対象を待つのをやめる（まだ待っていたなら）" },
  { from: resetCondition, to: "watch-target", action: "addWaiter", label: "また待つので、その対象を待つ" },
  { from: skip, to: "write", action: "withdraw", label: "書き込みで果たされる Action Item をやらなくなったら、承認待ちの書き込みを取りやめる" },
  { to: "watch-target", action: "addWaiter", label: "待つ条件の Action Item を作ったら、その対象を待つ（見張っていなければ見張りを始める）" },
  { from: autoStart, to: "agent-thread", label: "Claude Code に、この Action Item をやる作業を頼む（作業を始めたら、Task が AI の作業中になる）" },
];

export const scenarios = {
  "番待ちの間に成り立った待つ条件は、番が来たときに確かめ直してから果たす": [
    { do: initial, by: "AI", input: "条件で果たす" },
    { do: observeCondition, by: "同期", input: "成り立った" },
    { do: finishByCondition, by: "同期", input: "崩れた", denied: "今も成り立っているときだけ（番待ちの間に崩れたら、待ち直す）" },
    { do: finishByCondition, by: "同期", input: "番が来ている", expect: { status: "済んだ" } },
  ],
  "自動でやる書き込みの Action Item は、番が来たら書き込みを頼む": [
    { do: initial, by: "AI", input: "自動で書き込む" },
    { do: autoRequestWrite, by: "アプリ", input: "番待ち", denied: "番が来ているときだけ" },
    { do: autoRequestWrite, by: "ユーザー", input: "番が来ている", denied: "アプリだけ" },
    { do: autoRequestWrite, by: "アプリ", input: "番が来ている" },
    { do: completeByWrite, by: "アプリ", input: "番が来ている", expect: { status: "済んだ" } },
    { do: autoRequestWrite, by: "アプリ", input: "番が来ている", denied: "まだのときだけ" },
  ],
  "ボタンで頼む書き込みの Action Item は、自動では頼まない": [
    { do: initial, by: "AI", input: "書き込みで果たす" },
    { do: autoRequestWrite, by: "アプリ", input: "番が来ている", denied: "書き込みで果たされる、自動でやる Action Item だけ" },
  ],
  "完了待ちの Task では、Claude Code に頼まない": [
    { do: initial, by: "AI", input: "自動でやる" },
    { do: autoStart, by: "アプリ", input: "完了待ち", denied: "Task がやること のときだけ（完了待ちでは、自動で頼まない）" },
    { do: request, by: "ユーザー", input: "完了待ち", denied: "Task がやること のときだけ（完了待ちの Task では頼まない）" },
  ],
  "番が来る前に Claude Code に頼める。やり遂げても、番が来るまでは果たさない": [
    { do: initial, by: "AI", input: "頼めばやる" },
    { do: request, by: "ユーザー", input: "終わっている" },
    { do: succeed, by: "アプリ", input: "まだやり遂げていない", denied: "頼んだ作業がやり遂げたときだけ" },
    { do: succeed, by: "アプリ", input: "番待ち", denied: "番が来ているときだけ（番が来る前にやり遂げたら、番が来るまで待つ）" },
    { do: succeed, by: "アプリ", input: "元の項目が変わった", denied: "頼んだときから元の項目（PR の commit など）が変わっていないときだけ（変わっていたら果たさず、もう一度頼むよう見せる）" },
    { do: succeed, by: "アプリ", input: "番が来ている", expect: { status: "済んだ" } },
  ],
  "Action Item を作るのは、AI か定期の処理か、分かれ道を選んだユーザー": [{ do: initial, by: "同期", input: "人がやる", denied: "AI か定期の処理か、分かれ道を選んだユーザーだけ" }],
  "人が果たす Action Item は、番が来たら済ませられる": [
    { do: initial, by: "AI", input: "人がやる" },
    { do: complete, by: "ユーザー", input: "番待ち", denied: "番が来ているときだけ" },
    { do: choose, by: "ユーザー", input: "番が来ている", denied: "分かれ道だけ" },
    { do: completeByWrite, by: "アプリ", input: "番が来ている", denied: "書き込みで果たされる Action Item だけ" },
    { do: finishByCondition, by: "同期", input: "番が来ている", denied: "待つ条件が成り立ったときだけ" },
    { do: request, by: "ユーザー", input: "終わっている", denied: "Claude Code が果たす Action Item だけ" },
    { do: complete, by: "ユーザー", input: "番が来ている", expect: { status: "済んだ" } },
    { do: reopen, by: "ユーザー", expect: { status: "まだ" } },
  ],
  "分かれ道は、番が来たら選び、あとで選び直せる": [
    { do: initial, by: "AI", input: "分かれ道" },
    { do: complete, by: "ユーザー", input: "番が来ている", denied: "人か Claude Code が果たす Action Item だけ" },
    { do: rechoose, by: "ユーザー", denied: "選んだあとだけ" },
    { do: choose, by: "ユーザー", input: "番待ち", denied: "番が来ているときだけ" },
    { do: choose, by: "ユーザー", input: "番が来ている", expect: { status: "済んだ" } },
    { do: reopen, by: "ユーザー", denied: "人か Claude Code が果たす Action Item だけ" },
    { do: rechoose, by: "ユーザー", expect: { status: "済んだ" } },
  ],
  "待つ条件で果たされる Action Item は、番待ちの間に成り立っても、番が来たら果たされる": [
    { do: initial, by: "定期の処理", input: "条件で果たす" },
    { do: finishByCondition, by: "同期", input: "番が来ている", denied: "待つ条件が成り立ったときだけ" },
    { do: observeCondition, by: "AI", input: "成り立った", denied: "同期だけ" },
    { do: observeCondition, by: "同期", input: "成り立った", expect: { status: "まだ", progress: { observed: "成り立った" } } },
    { do: observeCondition, by: "同期", input: "達成できない", denied: "待つ条件で、まだ結果が出ていないときだけ" },
    { do: finishByCondition, by: "同期", input: "番待ち", denied: "番が来ているときだけ" },
    { do: finishByCondition, by: "同期", input: "番が来ている", expect: { status: "済んだ" } },
  ],
  "待つ対象が消えたら、達成できないになり、Task が受け取る": [
    { do: initial, by: "AI", input: "条件で果たす" },
    { do: observeCondition, by: "同期", input: "達成できない", expect: { progress: { observed: "達成できない" } } },
    { do: finishByCondition, by: "同期", input: "番が来ている", denied: "待つ条件が成り立ったときだけ" },
    { do: skip, by: "AI", expect: { status: "やらなくなった" } },
    { do: observeCondition, by: "同期", input: "成り立った", denied: "まだのときだけ" },
  ],
  "達成できないになっても、対象がまた現れたら、また待つ": [
    { do: initial, by: "AI", input: "条件で果たす" },
    { do: resetCondition, by: "同期", denied: "達成できないになったときだけ" },
    { do: observeCondition, by: "同期", input: "達成できない" },
    { do: resetCondition, by: "AI", denied: "同期だけ" },
    { do: resetCondition, by: "同期", expect: { progress: { observed: "まだ" } } },
    { do: observeCondition, by: "同期", input: "成り立った" },
    { do: finishByCondition, by: "同期", input: "番が来ている", expect: { status: "済んだ" } },
    { do: reopen, by: "ユーザー", denied: "人か Claude Code が果たす Action Item だけ" },
  ],
  "書き込みで果たされる Action Item は、番が来て書き込めたら済む": [
    { do: initial, by: "AI", input: "書き込みで果たす" },
    { do: completeByWrite, by: "ユーザー", input: "番が来ている", denied: "アプリだけ" },
    { do: completeByWrite, by: "アプリ", input: "番待ち", denied: "番が来ているときだけ" },
    { do: completeByWrite, by: "アプリ", input: "番が来ている", expect: { status: "済んだ" } },
  ],
  "自動でやる Action Item を、番が来たら一度だけ頼んでやり遂げる": [
    { do: initial, by: "AI", input: "自動でやる" },
    { do: autoStart, by: "アプリ", input: "番待ち", denied: "番が来ているときだけ" },
    { do: autoStart, by: "アプリ", input: "範囲に入らない", denied: "自動でやってよい範囲に入る作業だけ（入らなければ、ボタンで頼むまで待つ）" },
    { do: succeed, by: "アプリ", input: "番が来ている", denied: "Claude Code に頼んだ Action Item だけ" },
    { do: autoStart, by: "アプリ", input: "番が来ている" },
    { do: autoStart, by: "アプリ", input: "番が来ている", denied: "一度も頼んでいないときだけ" },
    { do: request, by: "ユーザー", input: "終わっていない", denied: "この Action Item の作業が終わっているときだけ（待ち行列も含む）" },
    { do: succeed, by: "ユーザー", input: "番が来ている", denied: "アプリだけ" },
    { do: succeed, by: "アプリ", input: "番が来ている", expect: { status: "済んだ" } },
    { do: reopen, by: "ユーザー", expect: { status: "まだ" } },
    { do: autoStart, by: "アプリ", input: "番が来ている", denied: "一度も頼んでいないときだけ" },
  ],
  "頼めばやる Action Item は自動では動かず、作業が終わったら頼み直せる": [
    { do: initial, by: "AI", input: "頼めばやる" },
    { do: autoStart, by: "アプリ", input: "番が来ている", denied: "自動でやる Action Item だけ" },
    { do: request, by: "ユーザー", input: "終わっている" },
    { do: request, by: "ユーザー", input: "終わっていない", denied: "この Action Item の作業が終わっているときだけ（待ち行列も含む）" },
    { do: request, by: "ユーザー", input: "終わっている" },
  ],
  "やらなくなった Action Item は、もう動かない": [
    { do: initial, by: "AI", input: "人がやる" },
    { do: skip, by: "アプリ", denied: "ユーザーか同期か AI だけ" },
    { do: skip, by: "AI", expect: { status: "やらなくなった" } },
    { do: complete, by: "ユーザー", input: "番が来ている", denied: "まだのときだけ" },
    { do: reopen, by: "ユーザー", denied: "済んだときだけ" },
    { do: skip, by: "AI", denied: "まだのときだけ" },
  ],
  "操作は決まった人と段階でだけ起きる": [
    { do: initial, by: "AI", input: "人がやる" },
    { do: succeed, by: "アプリ", input: "番が来ている", denied: "Claude Code に頼んだ Action Item だけ" },
    { do: reopen, by: "ユーザー", denied: "済んだときだけ" },
    { do: complete, by: "AI", input: "番が来ている", denied: "ユーザーだけ" },
    { do: choose, by: "AI", input: "番が来ている", denied: "ユーザーだけ" },
    { do: rechoose, by: "AI", denied: "ユーザーだけ" },
    { do: finishByCondition, by: "AI", input: "番が来ている", denied: "同期だけ" },
    { do: request, by: "AI", input: "終わっている", denied: "ユーザーだけ" },
    { do: autoStart, by: "ユーザー", input: "番が来ている", denied: "アプリだけ" },
    { do: complete, by: "ユーザー", input: "番が来ている" },
    { do: complete, by: "ユーザー", input: "番が来ている", denied: "まだのときだけ" },
    { do: choose, by: "ユーザー", input: "番が来ている", denied: "まだのときだけ" },
    { do: completeByWrite, by: "アプリ", input: "番が来ている", denied: "まだのときだけ" },
    { do: finishByCondition, by: "同期", input: "番が来ている", denied: "まだのときだけ" },
    { do: request, by: "ユーザー", input: "終わっている", denied: "まだのときだけ" },
    { do: autoStart, by: "アプリ", input: "番が来ている", denied: "まだのときだけ" },
    { do: reopen, by: "AI", denied: "ユーザーだけ" },
  ],
};
