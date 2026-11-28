import { Effect, Schema } from "effect";
import { PriorityLevel } from "../../llm/shared/vocabulary.js";
import type { RuleResult } from "./rule.js";

// specs/prioritization.spec.ts の Prioritization（Task の集約の中の、優先度の決まり方）

export const PrioritizationStatus = Schema.Literals(["未判定", "アプリが決めた", "ラベル未定", "ユーザーが決めた", "決めるのをやめた"]);
export const Priority = Schema.Struct({ level: PriorityLevel, reason: Schema.String });
export type Priority = typeof Priority.Type;

export const Prioritization = Schema.Struct({
  status: PrioritizationStatus,
  taskId: Schema.String,
  priority: Schema.NullOr(Priority),
  /** 決めるのに使った材料の指紋（期日・止めているか・今日の日付など）。変わったら決め直す */
  basisFingerprint: Schema.String,
  drivenByItemId: Schema.NullOr(Schema.String),
});
export type Prioritization = typeof Prioritization.Type;

export type PrioritizationActor = { readonly kind: "sync" } | { readonly kind: "decisions" } | { readonly kind: "user" };
export type JudgeResult = PriorityLevel | "閾値の間・断られた・形に合わない" | "答えが返らない";

export class PrioritizationDenied extends Schema.TaggedError<PrioritizationDenied>()("PrioritizationDenied", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

const guard = (operation: string) => (holds: boolean, reason: string) => (holds ? Effect.void : Effect.fail(new PrioritizationDenied({ operation, reason })));
const canDecide = (p: Prioritization) => p.status === "未判定" || p.status === "ラベル未定";

export const start = Effect.fn("Prioritization.start")(function* (input: { taskId: string; basis: string }, actor: PrioritizationActor) {
  yield* guard("initial")(actor.kind === "sync", "同期だけ");
  const p: Prioritization = { status: "未判定", taskId: input.taskId, priority: null, basisFingerprint: input.basis, drivenByItemId: null };
  return p;
});

/** reason は「期日まで 2 日で、手間が 1 日」のような見せるための一言（呼ぶ側が材料から書く） */
export const decideByRule = Effect.fn("Prioritization.decideByRule")(function* (p: Prioritization, actor: PrioritizationActor, rule: RuleResult, reason: string) {
  const ensure = guard("decideByRule");
  yield* ensure(actor.kind === "sync", "同期だけ");
  yield* ensure(canDecide(p), "未判定・ラベル未定のときだけ");
  if (rule === "規則では決めない" || rule === "今日中以上（今すぐかは判定）") return yield* new PrioritizationDenied({ operation: "decideByRule", reason: "規則でラベルが出たときだけ" });
  return { ...p, status: "アプリが決めた" as const, priority: { level: rule, reason } };
});

export const judge = Effect.fn("Prioritization.judge")(function* (p: Prioritization, actor: PrioritizationActor, rule: RuleResult, result: JudgeResult, askedBasis: string) {
  const ensure = guard("judge");
  yield* ensure(actor.kind === "decisions", "Decisions だけ");
  yield* ensure(canDecide(p), "未判定・ラベル未定のときだけ");
  yield* ensure(rule === "規則では決めない" || rule === "今日中以上（今すぐかは判定）", "規則で決まらなかったときだけ");
  yield* ensure(askedBasis === p.basisFingerprint, "判定に渡した材料が今のものと同じときだけ（判定の間に材料が変わったら、答えを捨てて判定し直す）");
  if (rule === "今日中以上（今すぐかは判定）" && result !== "今すぐ") {
    return { ...p, status: "アプリが決めた" as const, priority: { level: "今日中" as const, reason: "他の人を止めている" } };
  }
  if (result === "閾値の間・断られた・形に合わない" || result === "答えが返らない") return { ...p, status: "ラベル未定" as const, priority: null };
  return { ...p, status: "アプリが決めた" as const, priority: { level: result, reason: "判定した" } };
});

export const setByUser = Effect.fn("Prioritization.setByUser")(function* (p: Prioritization, actor: PrioritizationActor, level: PriorityLevel) {
  const ensure = guard("setByUser");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(p.status !== "決めるのをやめた", "Task が開いているときだけ");
  return { ...p, status: "ユーザーが決めた" as const, priority: { level, reason: "あなたが決めた" } };
});

/** 外しても、決め直すまではユーザーが決めたラベルのまま並べる（spec の遷移の不変条件） */
export const clearByUser = Effect.fn("Prioritization.clearByUser")(function* (p: Prioritization, actor: PrioritizationActor) {
  const ensure = guard("clearByUser");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(p.status === "ユーザーが決めた", "ユーザーが決めたときだけ");
  return { ...p, status: "未判定" as const };
});

export const basisChanged = Effect.fn("Prioritization.basisChanged")(function* (p: Prioritization, actor: PrioritizationActor, basis: string) {
  const ensure = guard("basisChanged");
  yield* ensure(actor.kind === "sync", "同期だけ");
  yield* ensure(p.status !== "ユーザーが決めた", "ユーザーが決めたラベルは変えない");
  yield* ensure(p.status !== "決めるのをやめた", "Task が開いているときだけ");
  return { ...p, status: p.status === "ラベル未定" ? ("ラベル未定" as const) : ("未判定" as const), basisFingerprint: basis };
});

export const stop = Effect.fn("Prioritization.stop")(function* (p: Prioritization, actor: PrioritizationActor) {
  const ensure = guard("stop");
  yield* ensure(actor.kind === "sync", "同期だけ");
  yield* ensure(p.status !== "決めるのをやめた", "Task が開いているときだけ");
  yield* ensure(p.status !== "ユーザーが決めた", "アプリが決めるときだけ");
  return { ...p, status: "決めるのをやめた" as const };
});

export const resume = Effect.fn("Prioritization.resume")(function* (p: Prioritization, actor: PrioritizationActor, basis: string) {
  const ensure = guard("resume");
  yield* ensure(actor.kind === "sync", "同期だけ");
  yield* ensure(p.status === "決めるのをやめた", "決めるのをやめたときだけ");
  return { ...p, status: "未判定" as const, basisFingerprint: basis };
});
