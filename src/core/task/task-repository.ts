import { and, eq, getColumns, isNull, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { Database } from "../db/database.js";
import { syncCursors, taskChanges, tasks } from "./schema.js";
import type { NewTask, Task, TaskChangeInput, TaskPatch, TaskWithUnread } from "./task.js";

export class TaskRepository extends Context.Service<TaskRepository, {
  findBySource(source: string, externalId: string): Effect.Effect<Option.Option<Task>>;
  insert(task: NewTask): Effect.Effect<Task>;
  update(id: number, patch: TaskPatch): Effect.Effect<Task>;
  recordChange(taskId: number, change: TaskChangeInput): Effect.Effect<void>;
  markChangesSeen(taskId: number): Effect.Effect<void>;
  readonly listTasks: Effect.Effect<ReadonlyArray<TaskWithUnread>>;
  loadCursor(source: string): Effect.Effect<Option.Option<unknown>>;
  saveCursor(source: string, cursor: unknown): Effect.Effect<void>;
  withTransaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}>()("live-todo/core/task/TaskRepository") {
  static readonly layer = Layer.effect(
    TaskRepository,
    Effect.gen(function* () {
      const db = yield* Database;
      const sqlClient = yield* SqlClient.SqlClient;
      const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

      const returnedRow = <A>(rows: ReadonlyArray<A>): Effect.Effect<A> =>
        Option.match(Option.fromNullishOr(rows[0]), {
          onNone: () => Effect.die(new Error("RETURNING が行を返さなかった")),
          onSome: Effect.succeed,
        });

      // DB の失敗を型のエラーにしない理由: ローカルの SQLite が失敗するのは
      // ディスク故障などの想定外の事態で、呼び出し側に回復手段がないため defect として扱う。
      const findBySource = Effect.fn("TaskRepository.findBySource")(function* (source: string, externalId: string) {
        const rows = yield* db
          .select()
          .from(tasks)
          .where(and(eq(tasks.source, source), eq(tasks.externalId, externalId)))
          .limit(1);
        return Option.fromNullishOr(rows[0]);
      }, Effect.orDie);

      const insert = Effect.fn("TaskRepository.insert")(function* (task: NewTask) {
        const now = yield* nowIso;
        const rows = yield* db.insert(tasks).values({ ...task, createdAt: now, updatedAt: now }).returning();
        return yield* returnedRow(rows);
      }, Effect.orDie);

      const update = Effect.fn("TaskRepository.update")(function* (id: number, patch: TaskPatch) {
        const rows = yield* db
          .update(tasks)
          .set({ ...patch, updatedAt: yield* nowIso })
          .where(eq(tasks.id, id))
          .returning();
        return yield* returnedRow(rows);
      }, Effect.orDie);

      const recordChange = Effect.fn("TaskRepository.recordChange")(function* (taskId: number, change: TaskChangeInput) {
        const now = yield* nowIso;
        yield* db.insert(taskChanges).values({
          taskId,
          kind: change.kind,
          detail: change.detail ?? null,
          occurredAt: now,
          seenAt: change.unread ? null : now,
        });
      }, Effect.orDie);

      const markChangesSeen = Effect.fn("TaskRepository.markChangesSeen")(function* (taskId: number) {
        yield* db
          .update(taskChanges)
          .set({ seenAt: yield* nowIso })
          .where(and(eq(taskChanges.taskId, taskId), isNull(taskChanges.seenAt)));
      }, Effect.orDie);

      const listTasks = db
        .select({
          ...getColumns(tasks),
          unreadChanges: sql<number>`(
            SELECT COUNT(*) FROM ${taskChanges}
            WHERE ${taskChanges.taskId} = ${tasks.id} AND ${taskChanges.seenAt} IS NULL
          )`.mapWith(Number),
        })
        .from(tasks)
        .orderBy(tasks.id)
        .pipe(Effect.orDie, Effect.withSpan("TaskRepository.listTasks"));

      const loadCursor = Effect.fn("TaskRepository.loadCursor")(function* (source: string) {
        const rows = yield* db.select({ cursor: syncCursors.cursor }).from(syncCursors).where(eq(syncCursors.source, source));
        return Option.map(Option.fromNullishOr(rows[0]), (row) => row.cursor);
      }, Effect.orDie);

      const saveCursor = Effect.fn("TaskRepository.saveCursor")(function* (source: string, cursor: unknown) {
        const now = yield* nowIso;
        yield* db
          .insert(syncCursors)
          .values({ source, cursor, updatedAt: now })
          .onConflictDoUpdate({ target: syncCursors.source, set: { cursor, updatedAt: now } });
      }, Effect.orDie);

      return TaskRepository.of({
        findBySource,
        insert,
        update,
        recordChange,
        markChangesSeen,
        listTasks,
        loadCursor,
        saveCursor,
        // db.transaction ではなく SqlClient.withTransaction を使う理由: 呼び出し側の Effect は tx ではなく db を
        // 使って書かれている。Drizzle の Effect 版も内部で SqlClient.withTransaction を使い、トランザクションは
        // fiber 単位で引き継がれるため、db 経由のクエリも同じトランザクションに入る。
        withTransaction: (effect) => sqlClient.withTransaction(effect).pipe(Effect.catchTag("SqlError", Effect.die)),
      });
    }),
  );
}
