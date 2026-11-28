import { DateTime, Effect, Schema } from "effect";
import { guard } from "../denied.js";

// specs/agent-run.spec.ts の Agent Run（AI に任せた作業 1 回）。Agent Thread を通してだけ扱う

export const AgentRunStatus = Schema.Literals(["待ち行列", "やっている", "判断中", "終わった", "止まった", "取り消した"]);
export type AgentRunStatus = typeof AgentRunStatus.Type;
export const AgentRunKind = Schema.Literals(["質問に答える", "Action Item をやる（読むだけ）", "Action Item をやる（直す）", "依存の更新を調べる", "PR を直す", "コンフリクトを直す"]);
export type AgentRunKind = typeof AgentRunKind.Type;
export const StopReason = Schema.Literals([
  "ユーザーが止めた",
  "追う項目が片付いたのでやめた",
  "うまくいかなかった",
  "アプリを閉じた",
  "決まった形の答えが返らない",
  "作業場所が消えた",
  "ユーザーが取り消した",
  "追う項目が片付いたので取り消した",
  "やらなくなった",
  "ユーザーが済ませた",
]);
export type StopReason = typeof StopReason.Type;

export const AgentRun = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  status: AgentRunStatus,
  kind: AgentRunKind,
  tools: Schema.Literals(["読むだけ", "直す"]),
  request: Schema.String,
  actionItemId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  trigger: Schema.Literals(["ユーザーが頼んだ", "Action Item から"]),
  subjectFingerprint: Schema.NullOr(Schema.String),
  notified: Schema.Boolean,
  result: Schema.NullOr(Schema.String),
  /** 止まった・取り消した理由。状態には持たず、記録として残す（spec） */
  stopReason: Schema.NullOr(StopReason),
  /** 途中経過（画面に出す。Task は変えない） */
  progress: Schema.Array(Schema.String),
  createdAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});
export type AgentRun = typeof AgentRun.Type;

export type AgentActor = { readonly kind: "user" } | { readonly kind: "agent" } | { readonly kind: "app" };
type Open = "開いている" | "開いていない";

const FIXES: ReadonlyArray<AgentRunKind> = ["PR を直す", "コンフリクトを直す", "Action Item をやる（直す）"];
const FROM_ITEM: ReadonlyArray<AgentRunKind> = ["Action Item をやる（読むだけ）", "Action Item をやる（直す）"];
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const finished = (run: AgentRun, status: "止まった" | "取り消した", stopReason: StopReason) =>
  Effect.map(nowIso, (at): AgentRun => ({ ...run, status, stopReason, finishedAt: at }));

/** 作業を頼む・Action Item から始める。渡す道具は作業の種類から決まる（呼ぶ側に選ばせない） */
export const requestRun = Effect.fn("AgentRun.request")(function* (
  actor: AgentActor,
  kind: AgentRunKind,
  task: Open,
  content: { id: string; taskId: string; request: string; actionItemId: string | null; subjectFingerprint: string | null },
) {
  const ensure = guard("agent-run", "initial");
  yield* ensure(actor.kind === "user" || actor.kind === "app", "ユーザーか、Action Item から始めるアプリだけ");
  yield* ensure(actor.kind === "user" || FROM_ITEM.includes(kind), "アプリが始めるのは、Action Item をやる作業だけ");
  yield* ensure(task === "開いている", "Task がやること のときだけ（完了待ち・終わった Task には頼まない）");
  const run: AgentRun = {
    ...content,
    status: "待ち行列",
    kind,
    tools: FIXES.includes(kind) ? "直す" : "読むだけ",
    sessionId: null,
    trigger: FROM_ITEM.includes(kind) ? "Action Item から" : "ユーザーが頼んだ",
    notified: false,
    result: null,
    stopReason: null,
    progress: [],
    createdAt: yield* nowIso,
    finishedAt: null,
  };
  return run;
});

export const start = Effect.fn("AgentRun.start")(function* (
  run: AgentRun,
  actor: AgentActor,
  given: { thread: "続けられる" | "続けられない"; task: Open; others: "ほかに動いている作業はない" | "ほかに動いている作業がある" },
) {
  const ensure = guard("agent-run", "start");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(run.status === "待ち行列", "待ち行列のときだけ");
  yield* ensure(given.others === "ほかに動いている作業はない", "この Task で、ほかに動いている作業がないときだけ（同時に動くのは 1 つまで）");
  yield* ensure(given.thread === "続けられる", "会話を続けられるときだけ（続けられないなら、先に新しい会話を始める）");
  yield* ensure(given.task === "開いている", "Task がやること のときだけ（完了待ち・終わった Task では始めない）");
  return { ...run, status: "やっている" as const };
});

export const succeed = Effect.fn("AgentRun.succeed")(function* (run: AgentRun, actor: AgentActor, result: string) {
  const ensure = guard("agent-run", "succeed");
  yield* ensure(actor.kind === "agent", "AI だけ");
  yield* ensure(run.status === "やっている", "やっているときだけ");
  return { ...run, status: "終わった" as const, result, finishedAt: yield* nowIso };
});

const isActive = (run: AgentRun) => run.status === "やっている" || run.status === "判断中";

export const fail = Effect.fn("AgentRun.fail")(function* (run: AgentRun, actor: AgentActor, reason: "うまくいかなかった" | "アプリを閉じた" | "作業場所が消えた") {
  const ensure = guard("agent-run", "fail");
  yield* ensure(actor.kind === "agent" || actor.kind === "app", "AI かアプリだけ");
  yield* ensure(isActive(run), "やっている・判断中のときだけ");
  return yield* finished(run, "止まった", reason);
});

export const stop = Effect.fn("AgentRun.stop")(function* (run: AgentRun, actor: AgentActor) {
  const ensure = guard("agent-run", "stop");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(isActive(run), "やっている・判断中のときだけ");
  return yield* finished(run, "止まった", "ユーザーが止めた");
});

export const interrupt = Effect.fn("AgentRun.interrupt")(function* (run: AgentRun, actor: AgentActor) {
  const ensure = guard("agent-run", "interrupt");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(run.status === "やっている", "やっているときだけ");
  yield* ensure(!run.notified, "まだ知らせていないときだけ（続けると判断したら、もう知らせない）");
  yield* ensure(run.subjectFingerprint !== null, "追う元の項目がある作業だけ");
  return { ...run, status: "判断中" as const, notified: true };
});

export const decide = Effect.fn("AgentRun.decide")(function* (run: AgentRun, actor: AgentActor, answer: "やめる" | "続ける" | "答えが返らない") {
  const ensure = guard("agent-run", "decide");
  yield* ensure(actor.kind === "agent", "AI だけ");
  yield* ensure(run.status === "判断中", "判断中のときだけ");
  if (answer === "続ける") return { ...run, status: "やっている" as const };
  return yield* finished(run, "止まった", answer === "やめる" ? "追う項目が片付いたのでやめた" : "決まった形の答えが返らない");
});

export const withdraw = Effect.fn("AgentRun.withdraw")(function* (run: AgentRun, actor: AgentActor, reason: "やらなくなった" | "ユーザーが済ませた") {
  const ensure = guard("agent-run", "withdraw");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(run.status === "待ち行列" || isActive(run), "終わっていないときだけ");
  return yield* finished(run, run.status === "待ち行列" ? "取り消した" : "止まった", reason);
});

export const cancel = Effect.fn("AgentRun.cancel")(function* (run: AgentRun, actor: AgentActor, reason: "ユーザーが取り消した" | "追う項目が片付いたので取り消した") {
  const ensure = guard("agent-run", "cancel");
  yield* ensure(actor.kind === "app" || actor.kind === "user", "アプリかユーザーだけ");
  yield* ensure(run.status === "待ち行列", "待ち行列のときだけ");
  return yield* finished(run, "取り消した", reason);
});

/** 終わっていない（待ち行列も含む） */
export const isOpenRun = (run: AgentRun) => run.status === "待ち行列" || isActive(run);
export const isActiveRun = isActive;
