import { Effect, Schema } from "effect";
import { guard } from "../denied.js";

// specs/completion-effect.spec.ts。Task が完了したらしておきたい後片付け 1 つ（計画の木の中にあり、Task を通してだけ扱う）

export const Delivery = Schema.Literals(["まだ", "頼んだ", "書き込んだ", "書き込めなかった", "取りやめた"]);
export type Delivery = typeof Delivery.Type;

export const CompletionEffect = Schema.Struct({
  id: Schema.String,
  checked: Schema.Boolean,
  delivery: Delivery,
  addedBy: Schema.Struct({ type: Schema.Literals(["AI", "ユーザー"]) }),
  title: Schema.String,
  subject: Schema.Struct({ uri: Schema.String }),
  operation: Schema.String,
  /** 操作ごとの中身。ドメインは読まず、書き込み先にそのまま渡す */
  params: Schema.Unknown,
  version: Schema.NullOr(Schema.String),
  writeId: Schema.NullOr(Schema.String),
});
export type CompletionEffect = typeof CompletionEffect.Type;

export type EffectActor = { readonly kind: "agent" } | { readonly kind: "user" } | { readonly kind: "app" };
export type EffectContent = { id: string; title: string; subjectUri: string; operation: string; params: unknown; version: string | null };

/** 足す。だれが足したものも初めは ☑（書き込む前に、完了待ちのチェックリストでユーザーが確かめる） */
export const addEffect = Effect.fn("CompletionEffect.add")(function* (content: EffectContent, actor: EffectActor) {
  yield* guard("completion-effect", "initial")(actor.kind === "agent" || actor.kind === "user", "AI かユーザーだけ");
  const effect: CompletionEffect = {
    id: content.id,
    checked: true,
    delivery: "まだ",
    addedBy: { type: actor.kind === "agent" ? "AI" : "ユーザー" },
    title: content.title,
    subject: { uri: content.subjectUri },
    operation: content.operation,
    params: content.params,
    version: content.version,
    writeId: null,
  };
  return effect;
});

const notWaiting = (effect: CompletionEffect) => effect.delivery === "まだ" || effect.delivery === "書き込めなかった";

export const check = Effect.fn("CompletionEffect.check")(function* (effect: CompletionEffect, actor: EffectActor) {
  const ensure = guard("completion-effect", "check");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(!effect.checked, "☑ を外しているときだけ");
  yield* ensure(notWaiting(effect), "まだ・書き込めなかったときだけ");
  return { ...effect, checked: true };
});

export const uncheck = Effect.fn("CompletionEffect.uncheck")(function* (effect: CompletionEffect, actor: EffectActor) {
  const ensure = guard("completion-effect", "uncheck");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(effect.checked, "☑ が付いているときだけ");
  yield* ensure(notWaiting(effect), "まだ・書き込めなかったときだけ");
  return { ...effect, checked: false };
});

export const fire = Effect.fn("CompletionEffect.fire")(function* (effect: CompletionEffect, actor: EffectActor, writeId: string) {
  const ensure = guard("completion-effect", "fire");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(effect.checked, "☑ が付いているときだけ");
  yield* ensure(effect.delivery === "まだ", "まだ頼んでいないときだけ");
  return { ...effect, delivery: "頼んだ" as const, writeId };
});

export const written = Effect.fn("CompletionEffect.written")(function* (effect: CompletionEffect, actor: EffectActor) {
  const ensure = guard("completion-effect", "written");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(effect.delivery === "頼んだ", "頼んだときだけ");
  return { ...effect, delivery: "書き込んだ" as const };
});

export const failed = Effect.fn("CompletionEffect.failed")(function* (effect: CompletionEffect, actor: EffectActor) {
  const ensure = guard("completion-effect", "failed");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(effect.delivery === "頼んだ", "頼んだときだけ");
  return { ...effect, delivery: "書き込めなかった" as const };
});

export const retry = Effect.fn("CompletionEffect.retry")(function* (effect: CompletionEffect, actor: EffectActor, writeId: string) {
  const ensure = guard("completion-effect", "retry");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(effect.checked, "☑ が付いているときだけ");
  yield* ensure(effect.delivery === "書き込めなかった", "書き込めなかったときだけ");
  return { ...effect, delivery: "頼んだ" as const, writeId };
});

export const withdraw = Effect.fn("CompletionEffect.withdraw")(function* (effect: CompletionEffect, actor: EffectActor) {
  const ensure = guard("completion-effect", "withdraw");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(notWaiting(effect), "頼んで結果を待っていないとき・まだ書き込んでいないときだけ");
  return { ...effect, delivery: "取りやめた" as const };
});

/** すべて書き込めた・取りやめた・☑ を外したなら、完了待ちの Task を終えてよい */
export const allSettled = (effects: ReadonlyArray<CompletionEffect>) => effects.every((effect) => effect.delivery === "書き込んだ" || effect.delivery === "取りやめた" || (!effect.checked && effect.delivery !== "頼んだ"));
