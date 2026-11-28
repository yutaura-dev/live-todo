import { Effect, Schema } from "effect";
import { guard } from "../denied.js";

// specs/account.spec.ts の Account（Source のアカウント 1 つ）

export const AccountProblem = Schema.Literals(["トークンが切れた", "権限が外された", "セッションが切れた", "権限を増やした"]);
export type AccountProblem = typeof AccountProblem.Type;

export const Account = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["つないでいない", "つないでいる", "つなぎ直しが要る", "外した"]),
  /** 外の世界のアカウント（scheme と authority）。作ったあと変わらない */
  origin: Schema.String,
  label: Schema.String,
  /** 取り込む範囲（Source ごとに形が違う） */
  scope: Schema.Unknown,
  problem: Schema.NullOr(AccountProblem),
});
export type Account = typeof Account.Type;

export type AccountActor = { readonly kind: "user" } | { readonly kind: "sync" } | { readonly kind: "app" };
type SameOrigin = "同じ origin のアカウントはない" | "外したアカウントと同じ origin" | "足しているアカウントと同じ origin";

export const addAccount = Effect.fn("Account.add")(function* (input: { id: string; origin: string; label: string; scope: unknown }, actor: AccountActor, sameOrigin: SameOrigin) {
  const ensure = guard("account", "initial");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(sameOrigin === "同じ origin のアカウントはない", "同じ origin のアカウントがないときだけ（外したアカウントと同じなら戻す。足しているアカウントと同じなら足せない）");
  const account: Account = { ...input, status: "つないでいない", problem: null };
  return account;
});

export const restoreAccount = Effect.fn("Account.restore")(function* (account: Account, actor: AccountActor) {
  const ensure = guard("account", "restore");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(account.status === "外した", "外したときだけ");
  return { ...account, status: "つないでいない" as const };
});

export const connect = Effect.fn("Account.connect")(function* (account: Account, actor: AccountActor, check: "通った" | "通らない") {
  const ensure = guard("account", "connect");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(account.status === "つないでいない" || account.status === "つなぎ直しが要る", "つないでいない・つなぎ直しが要るときだけ");
  yield* ensure(check === "通った", "認証が通ったときだけ");
  return { ...account, status: "つないでいる" as const, problem: null };
});

export const reject = Effect.fn("Account.reject")(function* (account: Account, actor: AccountActor, problem: Exclude<AccountProblem, "権限を増やした">) {
  const ensure = guard("account", "reject");
  yield* ensure(actor.kind === "sync" || actor.kind === "app", "同期・アプリだけ");
  yield* ensure(account.status === "つないでいる", "つないでいるときだけ");
  return { ...account, status: "つなぎ直しが要る" as const, problem };
});

/** 取り込む範囲を変える。権限が増えるなら、つないでいるアカウントはサインインし直しが要る（ADR-0017） */
export const changeScope = Effect.fn("Account.changeScope")(function* (account: Account, actor: AccountActor, permission: "権限が増える" | "変わらない", scope: unknown) {
  const ensure = guard("account", "changeScope");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(account.status !== "外した", "外していないときだけ");
  const scoped = { ...account, scope };
  return permission === "権限が増える" && account.status === "つないでいる" ? { ...scoped, status: "つなぎ直しが要る" as const, problem: "権限を増やした" as const } : scoped;
});

export const removeAccount = Effect.fn("Account.remove")(function* (account: Account, actor: AccountActor) {
  const ensure = guard("account", "remove");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(account.status !== "外した", "外していないときだけ");
  return { ...account, status: "外した" as const, problem: null };
});
