import { Context, Effect, Layer, Option } from "effect";
import { capture, remove, restore, type Snapshot, type SourceItem, update } from "../../../domain/source-item/source-item.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import type { StoreCorrupted } from "../../../store/task-store.js";
import { TaskIds } from "../task-service.js";

/** Adapter が届けた 1 件を、Source を知らない形にしたもの（uri はアカウントの origin にパスを続けたもの） */
export type Observed = { externalId: string; uri: string; url: string | null; stream: string; snapshot: Snapshot };
export type ObservedChange = { kind: "upserted"; item: Observed } | { kind: "removed"; externalId: string };
export type Ingested = { event: "appeared" | "changed" | "restored" | "removed" | "unchanged"; item: SourceItem };

const sync = { kind: "sync" } as const;

/** 取り込んだ変化を、事実（Source Item）に反映する。同じ事実かは uri だけで決める（source-item.spec） */
export class Ingestor extends Context.Service<Ingestor, { ingest(accountId: string, changes: ReadonlyArray<ObservedChange>): Effect.Effect<ReadonlyArray<Ingested>, StoreCorrupted> }>()(
  "live-todo/desktop/Ingestor",
) {
  static readonly layer = Layer.effect(
    Ingestor,
    Effect.gen(function* () {
      const store = yield* SourceItemStore;
      const ids = yield* TaskIds;
      // 同期だけが呼ぶので、ドメインに断られるのは実装の誤り
      const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

      const upsert = (accountId: string, observed: Observed) =>
        Effect.gen(function* () {
          const key = { accountId, externalId: observed.externalId };
          const existing = yield* store.findByUri(observed.uri);
          if (Option.isNone(existing)) {
            const item = yield* orDie(capture({ id: yield* ids.next, uri: observed.uri, url: observed.url, stream: observed.stream, snapshot: observed.snapshot }, sync));
            yield* store.save(item, key);
            return { event: "appeared", item } as Ingested;
          }
          const before = existing.value;
          const streams = before.streams.includes(observed.stream) ? before.streams : [...before.streams, observed.stream];
          if (before.presence === "消えた") {
            const item = { ...(yield* orDie(restore(before, sync, observed.snapshot))), streams };
            yield* store.save(item, key);
            return { event: "restored", item } as Ingested;
          }
          const changed = yield* orDie(update(before, sync, observed.snapshot));
          const item = { ...changed, streams };
          yield* store.save(item, key);
          return { event: changed === before ? "unchanged" : "changed", item } as Ingested;
        });

      const drop = (accountId: string, externalId: string) =>
        Effect.gen(function* () {
          const existing = yield* store.findByExternal(accountId, externalId);
          if (Option.isNone(existing) || existing.value.presence === "消えた") return [];
          const item = yield* orDie(remove(existing.value, sync, "範囲の外になった"));
          yield* store.save(item, { accountId, externalId });
          return [{ event: "removed", item } as Ingested];
        });

      const ingest = (accountId: string, changes: ReadonlyArray<ObservedChange>) =>
        Effect.map(
          Effect.forEach(changes, (change) => (change.kind === "upserted" ? Effect.map(upsert(accountId, change.item), (r) => [r]) : drop(accountId, change.externalId))),
          (lists) => lists.flat(),
        );

      return Ingestor.of({ ingest });
    }),
  );
}
