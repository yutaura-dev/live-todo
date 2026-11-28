import { Effect, Schema } from "effect";

// specs/ai-settings.spec.ts の AI Settings（PC に 1 つ）

export const Choice = Schema.Struct({ provider: Schema.String, model: Schema.NullOr(Schema.String) });
export type Choice = typeof Choice.Type;

export const AiUse = Schema.Literals(["decisions", "generation", "agent"]);
export type AiUse = typeof AiUse.Type;

export const AiProblem = Schema.Struct({
  use: Schema.Literals(["Decisions", "Generation", "Agent"]),
  reason: Schema.Literals(["API キーが切れた", "権限がない"]),
});
export type AiProblem = typeof AiProblem.Type;

export const AiSettings = Schema.Struct({
  status: Schema.Literals(["初期設定中", "使える", "使えない"]),
  uses: Schema.Struct({ decisions: Schema.NullOr(Choice), generation: Schema.NullOr(Choice), agent: Schema.NullOr(Choice) }),
  problem: Schema.NullOr(AiProblem),
});
export type AiSettings = typeof AiSettings.Type;

export type AiSettingsActor = { readonly kind: "user" } | { readonly kind: "app" };

export class AiSettingsDenied extends Schema.TaggedError<AiSettingsDenied>()("AiSettingsDenied", { operation: Schema.String, reason: Schema.String }) {}

const guard = (operation: string) => (holds: boolean, reason: string) => (holds ? Effect.void : Effect.fail(new AiSettingsDenied({ operation, reason })));

export const initialSettings: AiSettings = { status: "初期設定中", uses: { decisions: null, generation: null, agent: null }, problem: null };

/** 使い道を 1 つ設定する・選び直す・直す。3 つとも設定して確かめたら使える（認証が通らなかったものを直したときも） */
export const configure = Effect.fn("AiSettings.configure")(function* (settings: AiSettings, actor: AiSettingsActor, use: AiUse, choice: Choice, check: "通った" | "通らない") {
  const ensure = guard("configure");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(check === "通った", "認証を確かめて通ったときだけ");
  const uses = { ...settings.uses, [use]: choice };
  const complete = uses.decisions !== null && uses.generation !== null && uses.agent !== null;
  if (!complete) return { ...settings, uses };
  return { status: "使える" as const, uses, problem: null };
});

/** 認証が通らなかった（呼んだら断られた）。直すまで、アプリ全体を使えない */
export const reject = Effect.fn("AiSettings.reject")(function* (settings: AiSettings, actor: AiSettingsActor, problem: AiProblem) {
  const ensure = guard("reject");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(settings.status === "使える", "使えるときだけ");
  return { ...settings, status: "使えない" as const, problem };
});
