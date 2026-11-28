import { DateTime, Effect, Schema } from "effect";
import { guard } from "../denied.js";

// specs/write.spec.ts の Write（外への書き込み 1 回）。承認がなければ書き込まない（charter）

export const WriteStage = Schema.Literals(["承認待ち", "書き込み中", "書けたか分からない", "書き込んだ", "失敗", "取りやめた"]);
export const RequestedBy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("actionItem"), taskId: Schema.String, actionItemId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("completionEffect"), taskId: Schema.String, effectId: Schema.String }),
]);
export type RequestedBy = typeof RequestedBy.Type;
export const FailureKind = Schema.Literals(["権限が足りない", "書き込み先のエラー", "書けていなかった", "書けたか確かめられない", "アカウントを外した"]);

export const Write = Schema.Struct({
  id: Schema.String,
  stage: WriteStage,
  approval: Schema.NullOr(
    Schema.Struct({
      by: Schema.Literals(["ユーザーが確かめた", "自動でやってよい範囲", "完了のボタン"]),
      at: Schema.String,
      policy: Schema.NullOr(Schema.Struct({ operation: Schema.String, limit: Schema.String })),
    }),
  ),
  subject: Schema.Struct({ uri: Schema.String }),
  place: Schema.NullOr(Schema.Struct({ uri: Schema.String })),
  created: Schema.NullOr(Schema.Struct({ uri: Schema.String })),
  operation: Schema.String,
  /** 操作ごとの中身。ドメインは読まず、書き込み先にそのまま渡す */
  params: Schema.Unknown,
  version: Schema.NullOr(Schema.String),
  summary: Schema.String,
  requestedBy: RequestedBy,
  failure: Schema.NullOr(Schema.Struct({ kind: FailureKind, message: Schema.String })),
  finishedAt: Schema.NullOr(Schema.String),
});
export type Write = typeof Write.Type;

export type WriteActor = { readonly kind: "user" } | { readonly kind: "app" } | { readonly kind: "sync" } | { readonly kind: "target" };
export type Ready = "書き込める" | "書き込めない";

export type WriteRequest =
  | {
      way: "Action Item";
      item: "番が来ていて、まだ" | "番待ち" | "済んでいる";
      sameAsDefinition: boolean;
      openWrite: boolean;
      policy: "自動でやる" | "ユーザーが頼む・承認する";
      planVersion: "計画の版のまま" | "変わった";
      taskColumn: "やること" | "完了待ち";
      trigger: "auto" | "on_request";
      autoTried: boolean;
    }
  | { way: "完了したときにすること"; confirmed: boolean; openWrite: boolean; version: "版を持たない" | "見せた版のまま" | "変わった" };

export type WriteContent = {
  id: string;
  subject: { uri: string };
  place: { uri: string } | null;
  operation: string;
  params: unknown;
  version: string | null;
  summary: string;
  requestedBy: RequestedBy;
};

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** 書き込みを頼む。Action Item からユーザーが頼んだものは承認待ちにし、完了のボタンから頼んだもの・自動でやってよい範囲のものは書き込み中にする */
export const requestWrite = Effect.fn("Write.request")(function* (content: WriteContent, actor: WriteActor, request: WriteRequest, ready: Ready) {
  const ensure = guard("write", "initial");
  yield* ensure(
    request.way === "Action Item" ? actor.kind === "user" || (actor.kind === "app" && request.policy === "自動でやる") : actor.kind === "app",
    "Action Item からはユーザー（自動でやってよい範囲ならアプリも）、完了したときにすることからはアプリだけ",
  );
  yield* ensure(ready === "書き込める", "書き込める状態のときだけ");
  if (request.way === "Action Item" && actor.kind === "app") {
    yield* ensure(request.trigger === "auto", "自動で書き込むのは、番が来たら自動でやる Action Item だけ（ボタンで頼むものは、ユーザーが頼む）");
    yield* ensure(request.taskColumn === "やること", "自動で書き込むのは、Task がやることのときだけ（完了待ちでは、ユーザーが頼む）");
    yield* ensure(request.planVersion === "計画の版のまま", "自動で書き込むのは、計画を立てたときの版が今も同じときだけ");
    yield* ensure(!request.autoTried, "自動で頼むのは、Action Item ごとに 1 回だけ（失敗したあとはユーザーが頼む）");
  }
  if (request.way === "Action Item") {
    yield* ensure(request.item === "番が来ていて、まだ", "Action Item に番が来ていて、まだ済んでいないときだけ");
    yield* ensure(request.sameAsDefinition, "Action Item の定義と同じ対象・操作・作る場所だけ");
    yield* ensure(!request.openWrite, "その Action Item に、終わっていない書き込みがないときだけ");
  } else {
    yield* ensure(request.confirmed, "ユーザーが完了待ちのチェックリストを確かめて、完了のボタンを押したときだけ");
    yield* ensure(!request.openWrite, "その完了したときにすることに、終わっていない書き込みがないときだけ");
    yield* ensure(request.version !== "変わった", "版を持つ操作なら、見せたときの版が今も同じときだけ");
  }
  const now = yield* nowIso;
  const approved = request.way === "完了したときにすること" || actor.kind === "app";
  const write: Write = {
    ...content,
    stage: approved ? "書き込み中" : "承認待ち",
    approval: approved ? { by: request.way === "完了したときにすること" ? "完了のボタン" : "自動でやってよい範囲", at: now, policy: null } : null,
    created: null,
    failure: null,
    finishedAt: null,
  };
  return write;
});

export const approve = Effect.fn("Write.approve")(function* (write: Write, actor: WriteActor, version: "見せた版のまま" | "変わった", ready: Ready) {
  const ensure = guard("write", "approve");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(write.stage === "承認待ち", "確認中のときだけ");
  yield* ensure(version === "見せた版のまま", "見せた版が今も同じときだけ");
  yield* ensure(ready === "書き込める", "書き込める状態のときだけ");
  return { ...write, stage: "書き込み中" as const, approval: { by: "ユーザーが確かめた" as const, at: yield* nowIso, policy: null } };
});

export const cancel = Effect.fn("Write.cancel")(function* (write: Write, actor: WriteActor) {
  const ensure = guard("write", "cancel");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(write.stage === "承認待ち", "確認中のときだけ");
  return { ...write, stage: "取りやめた" as const };
});

export const withdraw = Effect.fn("Write.withdraw")(function* (write: Write, actor: WriteActor) {
  const ensure = guard("write", "withdraw");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(write.stage === "承認待ち", "確認中のときだけ");
  return { ...write, stage: "取りやめた" as const };
});

export const succeed = Effect.fn("Write.succeed")(function* (write: Write, actor: WriteActor) {
  const ensure = guard("write", "succeed");
  yield* ensure(actor.kind === "target", "書き込み先だけ");
  yield* ensure(write.stage === "書き込み中", "書き込み中のときだけ");
  return { ...write, stage: "書き込んだ" as const, finishedAt: yield* nowIso };
});

export const fail = Effect.fn("Write.fail")(function* (write: Write, actor: WriteActor, kind: "権限が足りない" | "書き込み先のエラー", message: string) {
  const ensure = guard("write", "fail");
  yield* ensure(actor.kind === "target", "書き込み先だけ");
  yield* ensure(write.stage === "書き込み中", "書き込み中のときだけ");
  return { ...write, stage: "失敗" as const, failure: { kind, message }, finishedAt: yield* nowIso };
});

/** 書き込み中のまま残っていた（アプリが止まった）。やり直すと二重に書き込むかもしれないので、外を確かめる段にする */
export const interrupt = Effect.fn("Write.interrupt")(function* (write: Write, actor: WriteActor) {
  const ensure = guard("write", "interrupt");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(write.stage === "書き込み中", "書き込み中のときだけ");
  return { ...write, stage: "書けたか分からない" as const };
});

export const settle = Effect.fn("Write.settle")(function* (write: Write, actor: WriteActor, result: "書けていた" | "書けていなかった" | "確かめられない") {
  const ensure = guard("write", "settle");
  yield* ensure(actor.kind === "sync", "同期だけ");
  yield* ensure(write.stage === "書けたか分からない", "書けたか分からないときだけ");
  const now = yield* nowIso;
  if (result === "書けていた") return { ...write, stage: "書き込んだ" as const, finishedAt: now };
  return { ...write, stage: "失敗" as const, failure: { kind: result === "確かめられない" ? ("書けたか確かめられない" as const) : ("書けていなかった" as const), message: "" }, finishedAt: now };
});

export const abandon = Effect.fn("Write.abandon")(function* (write: Write, actor: WriteActor) {
  const ensure = guard("write", "abandon");
  yield* ensure(actor.kind === "app", "アプリだけ");
  yield* ensure(write.stage === "書き込み中" || write.stage === "書けたか分からない", "書き込み中・書けたか分からないときだけ");
  return { ...write, stage: "失敗" as const, failure: { kind: "アカウントを外した" as const, message: "" }, finishedAt: yield* nowIso };
});
