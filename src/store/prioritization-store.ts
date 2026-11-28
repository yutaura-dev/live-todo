import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Prioritization } from "../domain/priority/prioritization.js";
import { StoreDatabase } from "./database.js";
import { prioritizations } from "./schema.js";
import { StoreCorrupted } from "./task-store.js";

const decode = Schema.decodeUnknownEffect(Prioritization);

export class PrioritizationStore extends Context.Service<
  PrioritizationStore,
  {
    save(p: Prioritization): Effect.Effect<void>;
    find(taskId: string): Effect.Effect<Option.Option<Prioritization>, StoreCorrupted>;
    all(): Effect.Effect<ReadonlyArray<Prioritization>, StoreCorrupted>;
  }
>()("live-todo/store/PrioritizationStore") {
  static readonly layer = Layer.effect(
    PrioritizationStore,
    Effect.gen(function* () {
      const db = yield* StoreDatabase;
      const toDomain = (row: typeof prioritizations.$inferSelect) =>
        decode({ ...row, priority: row.priority === null ? null : JSON.parse(row.priority) }).pipe(
          Effect.mapError((error) => new StoreCorrupted({ taskId: row.taskId, message: error.message })),
        );

      const save = (p: Prioritization) => {
        const row = { taskId: p.taskId, status: p.status, priority: p.priority === null ? null : JSON.stringify(p.priority), basisFingerprint: p.basisFingerprint, drivenByItemId: p.drivenByItemId };
        return db.insert(prioritizations).values(row).onConflictDoUpdate({ target: prioritizations.taskId, set: row }).pipe(Effect.asVoid, Effect.orDie);
      };
      const find = (taskId: string) =>
        db
          .select()
          .from(prioritizations)
          .where(eq(prioritizations.taskId, taskId))
          .pipe(
            Effect.orDie,
            Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(Option.none()) : Effect.map(toDomain(row), Option.some))),
          );
      const all = () => db.select().from(prioritizations).pipe(Effect.orDie, Effect.flatMap((rows) => Effect.forEach(rows, toDomain)));
      return PrioritizationStore.of({ save, find, all });
    }),
  );
}
