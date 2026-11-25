import { and, asc, eq, getColumns, isNull, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { Database, returnedRow } from "../db/database.js";
import { sourceItems, taskChanges, taskLinks, tasks } from "../db/schema.js";
import type { ItemState } from "../source/source-item.js";
import type { ChangeActor, LinkRole, TaskChangeKind, TaskStatus } from "./task.js";

export type Task = typeof tasks.$inferSelect;
export type TaskWithUnread = Task & { unreadChanges: number };
export type TaskChange = typeof taskChanges.$inferSelect;

export type NewTask = { title: string; status: TaskStatus };
export type TaskPatch = Partial<Pick<Task, "title" | "brief" | "status">>;

export type TaskChangeInput = {
  kind: TaskChangeKind;
  field?: string;
  before?: unknown;
  after?: unknown;
  /** false にすると更新マークの対象にしない（作成時の記録など） */
  unread: boolean;
  /** 誰が変えたか。指定しなければ同期（sync） */
  actor?: ChangeActor;
};

export class TaskRepository extends Context.Service<TaskRepository, {
  createTask(task: NewTask): Effect.Effect<Task>;
  linkItem(taskId: number, sourceItemId: number, role: LinkRole): Effect.Effect<void>;
  findTaskByItem(sourceItemId: number): Effect.Effect<Option.Option<Task>>;
  trackedItemStates(taskId: number): Effect.Effect<ReadonlyArray<ItemState>>;
  updateTask(id: number, patch: TaskPatch): Effect.Effect<Task>;
  recordChange(taskId: number, change: TaskChangeInput): Effect.Effect<void>;
  markChangesSeen(taskId: number): Effect.Effect<void>;
  readonly listTasks: Effect.Effect<ReadonlyArray<TaskWithUnread>>;
  listChanges(taskId: number): Effect.Effect<ReadonlyArray<TaskChange>>;
}>()("live-todo/core/task/TaskRepository") {
  static readonly layer = Layer.effect(
    TaskRepository,
    Effect.gen(function* () {
      const db = yield* Database;
      const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

      // DB の失敗を型のエラーにしない理由は SourceItemRepository と同じ（回復手段のない想定外の事態）。
      const createTask = Effect.fn("TaskRepository.createTask")(function* (task: NewTask) {
        const now = yield* nowIso;
        const rows = yield* db.insert(tasks).values({ ...task, createdAt: now, updatedAt: now }).returning();
        return yield* returnedRow(rows);
      }, Effect.orDie);

      const linkItem = Effect.fn("TaskRepository.linkItem")(function* (taskId: number, sourceItemId: number, role: LinkRole) {
        yield* db.insert(taskLinks).values({ taskId, sourceItemId, role, linkedAt: yield* nowIso });
      }, Effect.orDie);

      const findTaskByItem = Effect.fn("TaskRepository.findTaskByItem")(function* (sourceItemId: number) {
        const rows = yield* db
          .select(getColumns(tasks))
          .from(taskLinks)
          .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
          .where(eq(taskLinks.sourceItemId, sourceItemId))
          .limit(1);
        return Option.fromNullishOr(rows[0]);
      }, Effect.orDie);

      const trackedItemStates = Effect.fn("TaskRepository.trackedItemStates")(function* (taskId: number) {
        const rows = yield* db
          .select({ state: sourceItems.state })
          .from(taskLinks)
          .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
          .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.role, "tracks")));
        return rows.map((row) => row.state);
      }, Effect.orDie);

      const updateTask = Effect.fn("TaskRepository.updateTask")(function* (id: number, patch: TaskPatch) {
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
          field: change.field ?? null,
          before: change.before ?? null,
          after: change.after ?? null,
          actor: change.actor ?? "sync",
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

      const listChanges = Effect.fn("TaskRepository.listChanges")(function* (taskId: number) {
        return yield* db.select().from(taskChanges).where(eq(taskChanges.taskId, taskId)).orderBy(asc(taskChanges.id));
      }, Effect.orDie);

      return TaskRepository.of({
        createTask,
        linkItem,
        findTaskByItem,
        trackedItemStates,
        updateTask,
        recordChange,
        markChangesSeen,
        listTasks,
        listChanges,
      });
    }),
  );
}
