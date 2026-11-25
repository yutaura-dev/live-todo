import { and, asc, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { Database, returnedRow } from "../db/database.js";
import { activities, sourceItems, syncCursors } from "../db/schema.js";
import type { ActivityKind, ItemState, ItemTriage } from "./source-item.js";

export type SourceItem = typeof sourceItems.$inferSelect;
export type Activity = typeof activities.$inferSelect;

export type SourceItemDraft = {
  source: string;
  externalId: string;
  title: string;
  url: string;
  state: ItemState;
  fingerprint: string;
};

export class SourceItemRepository extends Context.Service<SourceItemRepository, {
  findItem(source: string, externalId: string): Effect.Effect<Option.Option<SourceItem>>;
  /** 新しい Item は triage を pending で作る。既存の Item は triage と初めて見た時刻を保ったまま更新する */
  upsertItem(draft: SourceItemDraft): Effect.Effect<SourceItem>;
  /** judgment: 仕分けたときの判定。対象外にしたものも含めて記録する */
  setTriage(itemId: number, triage: ItemTriage, judgment?: unknown): Effect.Effect<void>;
  recordActivity(itemId: number, kind: ActivityKind): Effect.Effect<void>;
  listActivities(itemId: number): Effect.Effect<ReadonlyArray<Activity>>;
  loadCursor(source: string): Effect.Effect<Option.Option<unknown>>;
  saveCursor(source: string, cursor: unknown): Effect.Effect<void>;
}>()("live-todo/core/source/SourceItemRepository") {
  static readonly layer = Layer.effect(
    SourceItemRepository,
    Effect.gen(function* () {
      const db = yield* Database;
      const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

      // DB の失敗を型のエラーにしない理由: ローカルの SQLite が失敗するのは
      // ディスク故障などの想定外の事態で、呼び出し側に回復手段がないため defect として扱う。
      const findItem = Effect.fn("SourceItemRepository.findItem")(function* (source: string, externalId: string) {
        const rows = yield* db
          .select()
          .from(sourceItems)
          .where(and(eq(sourceItems.source, source), eq(sourceItems.externalId, externalId)))
          .limit(1);
        return Option.fromNullishOr(rows[0]);
      }, Effect.orDie);

      const upsertItem = Effect.fn("SourceItemRepository.upsertItem")(function* (draft: SourceItemDraft) {
        const now = yield* nowIso;
        const content = { title: draft.title, url: draft.url, state: draft.state, fingerprint: draft.fingerprint, updatedAt: now };
        const rows = yield* db
          .insert(sourceItems)
          .values({ source: draft.source, externalId: draft.externalId, ...content, triage: "pending", firstSeenAt: now })
          .onConflictDoUpdate({ target: [sourceItems.source, sourceItems.externalId], set: content })
          .returning();
        return yield* returnedRow(rows);
      }, Effect.orDie);

      const setTriage = Effect.fn("SourceItemRepository.setTriage")(function* (itemId: number, triage: ItemTriage, judgment?: unknown) {
        yield* db
          .update(sourceItems)
          .set(judgment === undefined ? { triage } : { triage, judgment })
          .where(eq(sourceItems.id, itemId));
      }, Effect.orDie);

      const recordActivity = Effect.fn("SourceItemRepository.recordActivity")(function* (itemId: number, kind: ActivityKind) {
        yield* db.insert(activities).values({ sourceItemId: itemId, kind, occurredAt: yield* nowIso });
      }, Effect.orDie);

      const listActivities = Effect.fn("SourceItemRepository.listActivities")(function* (itemId: number) {
        return yield* db.select().from(activities).where(eq(activities.sourceItemId, itemId)).orderBy(asc(activities.id));
      }, Effect.orDie);

      const loadCursor = Effect.fn("SourceItemRepository.loadCursor")(function* (source: string) {
        const rows = yield* db.select({ cursor: syncCursors.cursor }).from(syncCursors).where(eq(syncCursors.source, source));
        return Option.map(Option.fromNullishOr(rows[0]), (row) => row.cursor);
      }, Effect.orDie);

      const saveCursor = Effect.fn("SourceItemRepository.saveCursor")(function* (source: string, cursor: unknown) {
        const now = yield* nowIso;
        yield* db
          .insert(syncCursors)
          .values({ source, cursor, updatedAt: now })
          .onConflictDoUpdate({ target: syncCursors.source, set: { cursor, updatedAt: now } });
      }, Effect.orDie);

      return SourceItemRepository.of({
        findItem,
        upsertItem,
        setTriage,
        recordActivity,
        listActivities,
        loadCursor,
        saveCursor,
      });
    }),
  );
}
