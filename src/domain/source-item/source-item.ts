import { DateTime, Effect, Schema } from "effect";
import { guard } from "../denied.js";

// specs/source-item.spec.ts・snapshot.value.ts・activity.value.ts

export const TrustedLine = Schema.Struct({ key: Schema.String, value: Schema.String });
export const Fact = Schema.Struct({ trusted: Schema.Array(TrustedLine), body: Schema.String });
export const SnapshotSchema = Schema.Struct({
  title: Schema.String,
  author: Schema.NullOr(Schema.String),
  fact: Fact,
  sourceUpdatedAt: Schema.NullOr(Schema.String),
  capturedAt: Schema.String,
});
/** 取り込んだ時刻は取り込む側で付けるので、届いた姿には持たない */
export type Snapshot = Omit<typeof SnapshotSchema.Type, "capturedAt">;

export const Removal = Schema.Literals(["削除された", "範囲の外になった"]);
export type Removal = typeof Removal.Type;

export const FieldChange = Schema.Struct({
  field: Schema.Literals(["title", "author", "trusted", "body"]),
  key: Schema.NullOr(Schema.String),
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
});
export type FieldChange = typeof FieldChange.Type;

export const SourceActivity = Schema.Struct({
  kind: Schema.Literals(["appeared", "changed", "removed", "restored"]),
  observedAt: Schema.String,
  sourceAt: Schema.NullOr(Schema.String),
  removal: Schema.NullOr(Removal),
  changes: Schema.Array(FieldChange),
});
export type SourceActivity = typeof SourceActivity.Type;

export const SourceItem = Schema.Struct({
  id: Schema.String,
  presence: Schema.Literals(["あり", "消えた"]),
  streams: Schema.Array(Schema.String),
  latest: SnapshotSchema,
  history: Schema.Array(SourceActivity),
  /** 同じ事実かは、この識別子だけで決まる（アカウントの origin + パス） */
  uri: Schema.String,
  url: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.String,
});
export type SourceItem = typeof SourceItem.Type;

export type SourceItemActor = { readonly kind: "sync" } | { readonly kind: "agent" } | { readonly kind: "user" };

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** 2 つの姿の、変わった項目すべての前と後（行は名前ごとに比べる） */
export function changesBetween(before: Snapshot, after: Snapshot): FieldChange[] {
  const changes: FieldChange[] = [];
  if (before.title !== after.title) changes.push({ field: "title", key: null, before: before.title, after: after.title });
  if (before.author !== after.author) changes.push({ field: "author", key: null, before: before.author, after: after.author });
  const keys = [...new Set([...before.fact.trusted.map((l) => l.key), ...after.fact.trusted.map((l) => l.key)])];
  for (const key of keys) {
    const was = before.fact.trusted.find((l) => l.key === key)?.value ?? null;
    const now = after.fact.trusted.find((l) => l.key === key)?.value ?? null;
    if (was !== now) changes.push({ field: "trusted", key, before: was, after: now });
  }
  if (before.fact.body !== after.fact.body) changes.push({ field: "body", key: null, before: before.fact.body, after: after.fact.body });
  return changes;
}

export const capture = Effect.fn("SourceItem.capture")(function* (
  input: { id: string; uri: string; url: string | null; stream: string; snapshot: Snapshot },
  actor: SourceItemActor,
) {
  yield* guard("source-item", "initial")(actor.kind === "sync", "同期だけ");
  const now = yield* nowIso;
  const item: SourceItem = {
    id: input.id,
    presence: "あり",
    streams: [input.stream],
    latest: { ...input.snapshot, capturedAt: now },
    history: [{ kind: "appeared", observedAt: now, sourceAt: input.snapshot.sourceUpdatedAt, removal: null, changes: [] }],
    uri: input.uri,
    url: input.url,
    firstSeenAt: now,
  };
  return item;
});

/** 中身が変わっていなければ出来事を足さない（同じ姿を取り込み直しても、履歴が増えない） */
export const update = Effect.fn("SourceItem.update")(function* (item: SourceItem, actor: SourceItemActor, snapshot: Snapshot) {
  const ensure = guard("source-item", "update");
  yield* ensure(actor.kind === "sync", "同期だけ");
  yield* ensure(item.presence === "あり", "Source にあるときだけ");
  const changes = changesBetween(item.latest, snapshot);
  if (changes.length === 0) return item;
  const now = yield* nowIso;
  return {
    ...item,
    latest: { ...snapshot, capturedAt: now },
    history: [...item.history, { kind: "changed" as const, observedAt: now, sourceAt: snapshot.sourceUpdatedAt, removal: null, changes }],
  };
});

export const remove = Effect.fn("SourceItem.remove")(function* (item: SourceItem, actor: SourceItemActor, removal: Removal) {
  const ensure = guard("source-item", "remove");
  yield* ensure(actor.kind === "sync", "同期だけ");
  yield* ensure(item.presence === "あり", "Source にあるときだけ");
  const now = yield* nowIso;
  return { ...item, presence: "消えた" as const, history: [...item.history, { kind: "removed" as const, observedAt: now, sourceAt: null, removal, changes: [] }] };
});

export const restore = Effect.fn("SourceItem.restore")(function* (item: SourceItem, actor: SourceItemActor, snapshot: Snapshot) {
  const ensure = guard("source-item", "restore");
  yield* ensure(actor.kind === "sync", "同期だけ");
  yield* ensure(item.presence === "消えた", "消えたときだけ");
  const now = yield* nowIso;
  return {
    ...item,
    presence: "あり" as const,
    latest: { ...snapshot, capturedAt: now },
    history: [...item.history, { kind: "restored" as const, observedAt: now, sourceAt: snapshot.sourceUpdatedAt, removal: null, changes: changesBetween(item.latest, snapshot) }],
  };
});
