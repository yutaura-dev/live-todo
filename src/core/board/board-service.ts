import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Database } from "../db/database.js";
import { sourceItems, taskLinks } from "../db/schema.js";
import { TaskRepository, type TaskWithUnread } from "../task/task-repository.js";
import type { TaskStatus } from "../task/task.js";

export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()("TaskNotFoundError", {
  taskId: Schema.Number,
}) {}

export const BOARD_COLUMNS = [
  { id: "needs_review", title: "要確認" },
  { id: "todo", title: "Todo" },
  { id: "in_progress", title: "進行中" },
  { id: "done", title: "完了" },
] as const satisfies ReadonlyArray<{ id: TaskStatus; title: string }>;

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]["id"];

export type CardJudgment = { method: string; probability?: number; reason?: string };

export type BoardCard = {
  id: number;
  title: string;
  status: TaskStatus;
  unreadChanges: number;
  updatedAt: string;
  /** tracks で紐づいた元の項目（PR / issue など）。手動で追加した Task にはない */
  url?: string;
  source?: string;
  judgment?: CardJudgment;
};

export type Board = { columns: ReadonlyArray<{ id: BoardColumnId; title: string; cards: BoardCard[] }> };

// 完了の列は増え続けるので、新しいものから一定数だけ出す
const DONE_COLUMN_LIMIT = 50;

const StoredJudgment = Schema.Struct({
  method: Schema.String,
  probability: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
});
const decodeJudgment = Schema.decodeUnknownOption(StoredJudgment);

const byAttention = (a: TaskWithUnread, b: TaskWithUnread) =>
  Number(b.unreadChanges > 0) - Number(a.unreadChanges > 0) || b.updatedAt.localeCompare(a.updatedAt);

export class BoardService extends Context.Service<BoardService, {
  readonly board: Effect.Effect<Board>;
  /** ユーザーがカードを動かした。ユーザーの操作として記録し、判定の正解として集められるようにする */
  moveTask(taskId: number, status: TaskStatus): Effect.Effect<void, TaskNotFoundError>;
  markSeen(taskId: number): Effect.Effect<void>;
}>()("live-todo/core/board/BoardService") {
  static readonly layer = Layer.effect(
    BoardService,
    Effect.gen(function* () {
      const db = yield* Database;
      const tasks = yield* TaskRepository;

      const trackedItems = db
        .select({ taskId: taskLinks.taskId, url: sourceItems.url, source: sourceItems.source, judgment: sourceItems.judgment })
        .from(taskLinks)
        .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
        .where(and(eq(taskLinks.role, "tracks")))
        .orderBy(asc(taskLinks.id))
        .pipe(Effect.orDie);

      const board = Effect.gen(function* () {
        const all = yield* tasks.listTasks;
        const itemOf = new Map<number, { url: string; source: string; judgment: unknown }>();
        for (const row of yield* trackedItems) {
          if (!itemOf.has(row.taskId)) itemOf.set(row.taskId, row);
        }

        const toCard = (task: TaskWithUnread): BoardCard => {
          const item = itemOf.get(task.id);
          const judgment = item === undefined ? Option.none() : decodeJudgment(item.judgment);
          return {
            id: task.id,
            title: task.title,
            status: task.status,
            unreadChanges: task.unreadChanges,
            updatedAt: task.updatedAt,
            ...(item === undefined ? {} : { url: item.url, source: item.source }),
            ...Option.match(judgment, {
              onNone: () => ({}),
              onSome: ({ method, probability, reason }) => ({
                judgment: {
                  method,
                  ...(probability === undefined ? {} : { probability }),
                  ...(reason === undefined ? {} : { reason }),
                },
              }),
            }),
          };
        };

        return {
          columns: BOARD_COLUMNS.map((column) => {
            const cards = all.filter((task) => task.status === column.id).toSorted(byAttention).map(toCard);
            return { ...column, cards: column.id === "done" ? cards.slice(0, DONE_COLUMN_LIMIT) : cards };
          }),
        };
      }).pipe(Effect.withSpan("BoardService.board"));

      const moveTask = Effect.fn("BoardService.moveTask")(function* (taskId: number, status: TaskStatus) {
        const found = yield* tasks.findTask(taskId);
        if (Option.isNone(found)) return yield* new TaskNotFoundError({ taskId });
        if (found.value.status === status) return;
        yield* tasks.updateTask(taskId, { status });
        // 自分の操作なので更新マークは付けない（unread: false）
        yield* tasks.recordChange(taskId, {
          kind: "field_changed",
          field: "status",
          before: found.value.status,
          after: status,
          unread: false,
          actor: "user",
        });
      });

      return BoardService.of({ board, moveTask, markSeen: tasks.markChangesSeen });
    }),
  );
}
