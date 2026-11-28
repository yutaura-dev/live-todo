import { Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { type Account, reject } from "../../../domain/account/account.js";
import { DocumentStore, documentsOf } from "../../../store/document-store.js";
import type { StoreCorrupted } from "../../../store/task-store.js";
import { Ingestor } from "../ingest/ingestor.js";
import { Router } from "../ingest/router.js";
import { Planner } from "../plan/planner.js";
import { TaskStore } from "../../../store/task-store.js";
import { accounts } from "./account-service.js";
import { SourceGateway } from "./gateway.js";

/** 取り込みの記録（アカウントごと。sync.spec の Sync の、カーソル・次に取りに行く時刻・続いた失敗） */
export const SyncRecord = Schema.Struct({
  id: Schema.String,
  cursor: Schema.Unknown,
  nextRunAt: Schema.String,
  failures: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
});
export type SyncRecord = typeof SyncRecord.Type;
export const syncs = documentsOf("sync", SyncRecord);

// 取り込む間隔と、失敗が続いたときの上限（sync.spec の判断表「次に取りに行くまで」）
const INTERVAL = Duration.minutes(1);
const MAX_BACKOFF = Duration.minutes(30);

export const backoffAfter = (failures: number) => Duration.min(Duration.times(INTERVAL, 2 ** failures), MAX_BACKOFF);

export type SyncOutcome = { accountId: string; result: "取り込めた" | "まだ" | "取り込めなかった"; changedTaskIds: ReadonlyArray<string> };

/** つないでいるアカウントのうち、時刻が来たものを取り込み、届いた事実を振り分ける */
export class SyncRunner extends Context.Service<SyncRunner, { runOnce(): Effect.Effect<ReadonlyArray<SyncOutcome>, StoreCorrupted> }>()("live-todo/desktop/SyncRunner") {
  static readonly layer = Layer.effect(
    SyncRunner,
    Effect.gen(function* () {
      const gateway = yield* SourceGateway;
      const ingestor = yield* Ingestor;
      const router = yield* Router;
      const docs = yield* DocumentStore;
      const planner = yield* Planner;
      const tasks = yield* TaskStore;

      const runAccount = (account: Account) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const record = Option.getOrElse(yield* syncs.find(account.id), () => ({ id: account.id, cursor: null, nextRunAt: DateTime.formatIso(now), failures: 0, lastError: null }) as SyncRecord);
          if (DateTime.formatIso(now) < record.nextRunAt) return { accountId: account.id, result: "まだ", changedTaskIds: [] } as SyncOutcome;
          const fetched = yield* gateway.fetch(account, record.cursor).pipe(Effect.result);
          if (fetched._tag === "Failure") {
            const failures = record.failures + 1;
            yield* syncs.save({ ...record, failures, lastError: fetched.failure.reason, nextRunAt: DateTime.formatIso(DateTime.addDuration(now, backoffAfter(failures))) });
            if (fetched.failure.reason === "トークンが通らない") yield* accounts.save(yield* Effect.orDie(reject(account, { kind: "sync" }, "トークンが切れた")));
            return { accountId: account.id, result: "取り込めなかった", changedTaskIds: [] } as SyncOutcome;
          }
          const ingested = yield* ingestor.ingest(account.id, fetched.success.changes);
          const changed: string[] = [];
          for (const entry of ingested) {
            if (entry.event !== "appeared" && entry.event !== "restored") continue;
            const routed = yield* router.route(entry.item);
            changed.push(...routed.changedTaskIds);
            // AI が作った Task は、計画を立てる（立てられなくても、Task は残る。計画は未定のまま）
            for (const id of routed.createdTaskIds) {
              const created = yield* tasks.find(id);
              if (Option.isSome(created)) yield* planner.revise(created.value);
            }
          }
          // カーソルは、変化を事実に反映したあとで進める（反映だけが失敗して取りこぼさないように。sync.spec）
          yield* syncs.save({ id: account.id, cursor: fetched.success.nextCursor, failures: 0, lastError: null, nextRunAt: DateTime.formatIso(DateTime.addDuration(now, INTERVAL)) });
          return { accountId: account.id, result: "取り込めた", changedTaskIds: changed } as SyncOutcome;
        });

      const runOnce = () =>
        Effect.gen(function* () {
          const connected = (yield* accounts.all()).filter((account) => account.status === "つないでいる");
          return yield* Effect.forEach(connected, runAccount);
        }).pipe(Effect.provideService(DocumentStore, docs));

      return SyncRunner.of({ runOnce });
    }),
  );
}
