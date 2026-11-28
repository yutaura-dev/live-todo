import { Effect, Schema } from "effect";
import { guard } from "../denied.js";

// specs/autonomy-policy.spec.ts。AI が頼まれず・承認されずに、どこまで自動でやってよいかをユーザーが決める（ADR-0023）

export const Level = Schema.Literals(["調べる", "ローカルの書き込み", "外への書き込み（下書き）", "外への書き込み（本番）"]);
export type Level = typeof Level.Type;
const ORDER: ReadonlyArray<Level> = ["調べる", "ローカルの書き込み", "外への書き込み（下書き）", "外への書き込み（本番）"];
/** 上限を決めていない操作は、ローカルの書き込みまで（新しく足された操作が、知らないうちに外へ書き込まないように） */
const UNSET_LIMIT: Level = "ローカルの書き込み";

export const AutonomyPolicy = Schema.Struct({ limits: Schema.Array(Schema.Struct({ operation: Schema.String, limit: Level })) });
export type AutonomyPolicy = typeof AutonomyPolicy.Type;
export type PolicyActor = { readonly kind: "user" } | { readonly kind: "app" };

export const initialPolicy = Effect.fn("AutonomyPolicy.initial")(function* (actor: PolicyActor) {
  yield* guard("autonomy-policy", "initial")(actor.kind === "app", "アプリだけ");
  return { limits: [] } as AutonomyPolicy;
});

/** 同じ操作の上限は置き換える（同じ操作の上限は 1 つだけ） */
export const setOperationLimit = Effect.fn("AutonomyPolicy.setOperationLimit")(function* (policy: AutonomyPolicy, actor: PolicyActor, operation: string, limit: Level) {
  yield* guard("autonomy-policy", "setOperationLimit")(actor.kind === "user", "ユーザーだけ");
  return { limits: [...policy.limits.filter((entry) => entry.operation !== operation), { operation, limit }] } as AutonomyPolicy;
});

export const clearOperationLimit = Effect.fn("AutonomyPolicy.clearOperationLimit")(function* (policy: AutonomyPolicy, actor: PolicyActor, operation: string) {
  yield* guard("autonomy-policy", "clearOperationLimit")(actor.kind === "user", "ユーザーだけ");
  return { limits: policy.limits.filter((entry) => entry.operation !== operation) } as AutonomyPolicy;
});

export type Target = "外に書き込まない" | "その Task の事実そのもの" | "ほかの対象（同じアカウントでも）" | "元の事実と違う場所に作る";

/** 判断表「自動でやってよいか」 */
export function allowed(level: Level, limit: Level | "決めていない", target: Target): "自動でやる" | "ユーザーが頼む・承認する" {
  const ceiling = limit === "決めていない" ? UNSET_LIMIT : limit;
  if (ORDER.indexOf(level) > ORDER.indexOf(ceiling)) return "ユーザーが頼む・承認する";
  if (target === "ほかの対象（同じアカウントでも）" || target === "元の事実と違う場所に作る") return "ユーザーが頼む・承認する";
  return "自動でやる";
}

export const limitOf = (policy: AutonomyPolicy, operation: string): Level | "決めていない" => policy.limits.find((entry) => entry.operation === operation)?.limit ?? "決めていない";
