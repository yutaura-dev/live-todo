import { asc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Task } from "../domain/task/task.js";
import { StoreDatabase } from "./database.js";
import { taskActivities, tasks } from "./schema.js";

/** DB の行が Task の形に戻らなかった（手で書き換えられた・マイグレーションの誤り） */
export class StoreCorrupted extends Schema.TaggedError<StoreCorrupted>()("StoreCorrupted", { taskId: Schema.String, message: Schema.String }) {}

const decodeTask = Schema.decodeUnknownEffect(Task);
const json = (value: unknown) => (value === null ? null : JSON.stringify(value));
const parse = (value: string | null): unknown => (value === null ? null : JSON.parse(value));

export class TaskStore extends Context.Service<
  TaskStore,
  {
    save(task: Task): Effect.Effect<void>;
    find(id: string): Effect.Effect<Option.Option<Task>, StoreCorrupted>;
    /** ボードに出す Task（やらないことにした・まとめた Task は出さない） */
    listForBoard(): Effect.Effect<ReadonlyArray<Task>, StoreCorrupted>;
  }
>()("live-todo/store/TaskStore") {
  static readonly layer = Layer.effect(
    TaskStore,
    Effect.gen(function* () {
      const db = yield* StoreDatabase;

      const rowsToTask = (row: typeof tasks.$inferSelect, activities: ReadonlyArray<typeof taskActivities.$inferSelect>) =>
        decodeTask({
          ...row,
          closure: parse(row.closure),
          due: parse(row.due),
          sourceItemIds: JSON.parse(row.sourceItemIds),
          history: activities.map((activity) => ({
            kind: activity.kind,
            by: activity.by,
            occurredAt: activity.occurredAt,
            changes: JSON.parse(activity.changes),
            cause: activity.cause,
          })),
        }).pipe(Effect.mapError((error) => new StoreCorrupted({ taskId: row.id, message: error.message })));

      const load = (rows: ReadonlyArray<typeof tasks.$inferSelect>) =>
        Effect.gen(function* () {
          if (rows.length === 0) return [];
          const activities = yield* db
            .select()
            .from(taskActivities)
            .where(inArray(taskActivities.taskId, rows.map((row) => row.id)))
            .orderBy(asc(taskActivities.seq))
            .pipe(Effect.orDie);
          return yield* Effect.forEach(rows, (row) => rowsToTask(row, activities.filter((activity) => activity.taskId === row.id)));
        });

      // 出来事は足すだけなので、保存済みの数より後ろだけを足す（前の出来事を書き換えない）
      const save = (task: Task) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const row = {
                id: task.id,
                status: task.status,
                closure: json(task.closure),
                pendingReason: task.pendingReason,
                completion: task.completion,
                title: task.title,
                brief: task.brief,
                due: json(task.due),
                blocksOthers: task.blocksOthers,
                sourceItemIds: JSON.stringify(task.sourceItemIds),
                lastSeenAt: task.lastSeenAt,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt,
              };
              yield* tx.insert(tasks).values(row).onConflictDoUpdate({ target: tasks.id, set: row });
              const stored = yield* tx.select({ seq: taskActivities.seq }).from(taskActivities).where(eq(taskActivities.taskId, task.id));
              const fresh = task.history.slice(stored.length).map((activity, i) => ({
                taskId: task.id,
                seq: stored.length + i,
                kind: activity.kind,
                by: activity.by,
                occurredAt: activity.occurredAt,
                changes: JSON.stringify(activity.changes),
                cause: activity.cause,
              }));
              if (fresh.length > 0) yield* tx.insert(taskActivities).values(fresh);
            }),
          )
          .pipe(Effect.orDie);

      const find = (id: string) =>
        Effect.gen(function* () {
          const rows = yield* db.select().from(tasks).where(eq(tasks.id, id)).pipe(Effect.orDie);
          const [task] = yield* load(rows);
          return Option.fromNullishOr(task);
        });

      const listForBoard = () =>
        Effect.gen(function* () {
          const rows = yield* db.select().from(tasks).orderBy(asc(tasks.createdAt)).pipe(Effect.orDie);
          const all = yield* load(rows);
          return all.filter((task) => task.closure === null || task.closure.outcome === "done");
        });

      return TaskStore.of({ save, find, listForBoard });
    }),
  );
}
