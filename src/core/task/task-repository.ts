import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { type NewTask, Task, type TaskChangeInput, type TaskPatch, TaskWithUnread } from "./task.js";

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
      const sql = yield* SqlClient.SqlClient;
      const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

      const findTaskById = SqlSchema.findOne({
        Request: Schema.Int,
        Result: Task,
        execute: (id) => sql`SELECT * FROM task_rows WHERE id = ${id}`,
      });

      const findTaskBySource = SqlSchema.findOneOption({
        Request: Schema.Struct({ source: Schema.String, externalId: Schema.String }),
        Result: Task,
        execute: ({ source, externalId }) =>
          sql`SELECT * FROM task_rows WHERE source = ${source} AND externalId = ${externalId}`,
      });

      const listAll = SqlSchema.findAll({
        Request: Schema.Void,
        Result: TaskWithUnread,
        execute: () => sql`SELECT * FROM task_rows ORDER BY id`,
      });

      const findCursor = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ cursor: Schema.fromJsonString(Schema.Unknown) }),
        execute: (source) => sql`SELECT cursor FROM sync_cursors WHERE source = ${source}`,
      });

      // DB の失敗を型のエラーにしない理由: ローカルの SQLite が失敗するのは
      // ディスク故障などの想定外の事態で、呼び出し側に回復手段がないため defect として扱う。
      const insert = Effect.fn("TaskRepository.insert")(function* (task: NewTask) {
        const now = yield* nowIso;
        const rows = yield* sql<{ id: number }>`
          INSERT INTO tasks ${sql.insert({
            source: task.source,
            external_id: task.externalId,
            title: task.title,
            url: task.url,
            status: task.status,
            fingerprint: task.fingerprint,
            created_at: now,
            updated_at: now,
          })} RETURNING id
        `;
        return yield* findTaskById(rows[0]!.id);
      }, Effect.orDie);

      const update = Effect.fn("TaskRepository.update")(function* (id: number, patch: TaskPatch) {
        const values = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
        yield* sql`UPDATE tasks SET ${sql.update({ ...values, updated_at: yield* nowIso })} WHERE id = ${id}`;
        return yield* findTaskById(id);
      }, Effect.orDie);

      const recordChange = Effect.fn("TaskRepository.recordChange")(function* (taskId: number, change: TaskChangeInput) {
        const now = yield* nowIso;
        yield* sql`
          INSERT INTO task_changes ${sql.insert({
            task_id: taskId,
            kind: change.kind,
            detail: change.detail === undefined ? null : JSON.stringify(change.detail),
            occurred_at: now,
            seen_at: change.unread ? null : now,
          })}
        `;
      }, Effect.orDie);

      const markChangesSeen = Effect.fn("TaskRepository.markChangesSeen")(function* (taskId: number) {
        yield* sql`UPDATE task_changes SET seen_at = ${yield* nowIso} WHERE task_id = ${taskId} AND seen_at IS NULL`;
      }, Effect.orDie);

      const loadCursor = Effect.fn("TaskRepository.loadCursor")(function* (source: string) {
        const row = yield* findCursor(source);
        return Option.map(row, ({ cursor }) => cursor);
      }, Effect.orDie);

      const saveCursor = Effect.fn("TaskRepository.saveCursor")(function* (source: string, cursor: unknown) {
        const now = yield* nowIso;
        yield* sql`
          INSERT INTO sync_cursors (source, cursor, updated_at) VALUES (${source}, ${JSON.stringify(cursor)}, ${now})
          ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
        `;
      }, Effect.orDie);

      return TaskRepository.of({
        findBySource: (source, externalId) =>
          findTaskBySource({ source, externalId }).pipe(Effect.orDie, Effect.withSpan("TaskRepository.findBySource")),
        insert,
        update,
        recordChange,
        markChangesSeen,
        listTasks: listAll(undefined).pipe(Effect.orDie, Effect.withSpan("TaskRepository.listTasks")),
        loadCursor,
        saveCursor,
        withTransaction: (effect) => sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", Effect.die)),
      });
    }),
  );
}
