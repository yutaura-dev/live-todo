import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Database } from "../db/database.js";
import { agentRuns, sourceItems, taskLinks } from "../db/schema.js";
import { TaskRepository, type TaskWithUnread } from "../task/task-repository.js";
import type { TaskStatus } from "../task/task.js";
import { chooseOption, completeStep, currentSteps, decodePlan, type Effort, type NextActionPlan } from "../task/next-actions.js";

export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()("TaskNotFoundError", {
  taskId: Schema.Number,
}) {}

export const BOARD_COLUMNS = [
  { id: "needs_review", title: "要確認" },
  { id: "agent_running", title: "AI が調査中" },
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
  /** 今の状況と次の一手（AI の調査の結論など） */
  brief?: string;
  /** いま着手できる次にやることと、その手間 */
  nextActions?: ReadonlyArray<{ title: string; effort: Effort }>;
  /** AI が調査中のレーンにあるとき、調べている最中か、調査待ちの何番目か */
  agent?: { state: "running" } | { state: "queued"; position: number };
  /** tracks で紐づいた元の項目（PR / issue など）。手動で追加した Task にはない */
  url?: string;
  source?: string;
  judgment?: CardJudgment;
};

export type TaskDetailItem = {
  role: string;
  source: string;
  title: string;
  url: string;
  state: string;
  judgment: CardJudgment | undefined;
};

export type TaskDetailChange = {
  kind: string;
  field: string | null;
  before: unknown;
  after: unknown;
  actor: string;
  occurredAt: string;
  unread: boolean;
};

export type TaskDetailAgentRun = {
  kind: string;
  status: string;
  result: unknown;
  error: string | null;
  sessionId: string | null;
  costUsd: number | undefined;
  startedAt: string;
  finishedAt: string | null;
};

export type TaskDetail = {
  id: number;
  title: string;
  brief: string | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  items: TaskDetailItem[];
  /** 新しい順 */
  changes: TaskDetailChange[];
  /** 最後に AI に任せた作業 */
  agentRun?: TaskDetailAgentRun;
  /** 次にやること（手順の並び全体） */
  nextActions?: NextActionPlan;
  /** いま着手できる手順の id */
  currentStepIds?: string[];
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
  taskDetail(taskId: number): Effect.Effect<TaskDetail, TaskNotFoundError>;
  /** 次にやることの手順を済ませる */
  completeStep(taskId: number, stepId: string): Effect.Effect<void, TaskNotFoundError>;
  /** 次にやることの分かれ道を選ぶ */
  chooseOption(taskId: number, stepId: string, optionKey: string): Effect.Effect<void, TaskNotFoundError>;
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

      const activeRuns = db
        .select({ taskId: agentRuns.taskId, status: agentRuns.status })
        .from(agentRuns)
        .where(inArray(agentRuns.status, ["queued", "running"]))
        .orderBy(asc(agentRuns.id))
        .pipe(Effect.orDie);

      const board = Effect.gen(function* () {
        const all = yield* tasks.listTasks;
        const agentOf = new Map<number, NonNullable<BoardCard["agent"]>>();
        let position = 0;
        for (const run of yield* activeRuns) {
          agentOf.set(run.taskId, run.status === "running" ? { state: "running" } : { state: "queued", position: ++position });
        }
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
            ...(task.brief === null ? {} : { brief: task.brief }),
            ...(agentOf.has(task.id) ? { agent: agentOf.get(task.id)! } : {}),
            ...Option.match(decodePlan(task.nextActions), {
              onNone: () => ({}),
              onSome: (plan) => ({ nextActions: currentSteps(plan).map((step) => ({ title: step.title, effort: step.effort })) }),
            }),
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

      const toJudgment = (stored: unknown): CardJudgment | undefined =>
        Option.match(decodeJudgment(stored), {
          onNone: () => undefined,
          onSome: ({ method, probability, reason }) => ({
            method,
            ...(probability === undefined ? {} : { probability }),
            ...(reason === undefined ? {} : { reason }),
          }),
        });

      const taskDetail = Effect.fn("BoardService.taskDetail")(function* (taskId: number) {
        const found = yield* tasks.findTask(taskId);
        if (Option.isNone(found)) return yield* new TaskNotFoundError({ taskId });
        const task = found.value;

        const itemRows = yield* db
          .select({
            role: taskLinks.role,
            source: sourceItems.source,
            title: sourceItems.title,
            url: sourceItems.url,
            state: sourceItems.state,
            judgment: sourceItems.judgment,
          })
          .from(taskLinks)
          .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
          .where(eq(taskLinks.taskId, taskId))
          .orderBy(asc(taskLinks.id))
          .pipe(Effect.orDie);
        const changes = yield* tasks.listChanges(taskId);
        const [lastRun] = yield* db.select().from(agentRuns).where(eq(agentRuns.taskId, taskId)).orderBy(desc(agentRuns.id)).limit(1).pipe(Effect.orDie);

        return {
          id: task.id,
          title: task.title,
          brief: task.brief,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          items: itemRows.map((row) => ({ ...row, judgment: toJudgment(row.judgment) })),
          changes: changes.toReversed().map((change) => ({
            kind: change.kind,
            field: change.field,
            before: change.before,
            after: change.after,
            actor: change.actor,
            occurredAt: change.occurredAt,
            unread: change.seenAt === null,
          })),
          ...Option.match(decodePlan(task.nextActions), {
            onNone: () => ({}),
            onSome: (plan) => ({ nextActions: plan, currentStepIds: currentSteps(plan).map((step) => step.id) }),
          }),
          ...(lastRun === undefined
            ? {}
            : {
                agentRun: {
                  kind: lastRun.kind,
                  status: lastRun.status,
                  result: lastRun.result,
                  error: lastRun.error,
                  sessionId: lastRun.sessionId,
                  costUsd: lastRun.costUsd === null ? undefined : Number(lastRun.costUsd),
                  startedAt: lastRun.startedAt,
                  finishedAt: lastRun.finishedAt,
                },
              }),
        } satisfies TaskDetail;
      });

      const updatePlan = Effect.fnUntraced(function* (taskId: number, change: (plan: NextActionPlan) => NextActionPlan) {
        const found = yield* tasks.findTask(taskId);
        if (Option.isNone(found)) return yield* new TaskNotFoundError({ taskId });
        const plan = decodePlan(found.value.nextActions);
        if (Option.isNone(plan)) return;
        yield* tasks.updateTask(taskId, { nextActions: change(plan.value) });
      });

      return BoardService.of({
        board,
        moveTask,
        markSeen: tasks.markChangesSeen,
        taskDetail,
        completeStep: (taskId, stepId) => updatePlan(taskId, (plan) => completeStep(plan, stepId)),
        chooseOption: (taskId, stepId, optionKey) => updatePlan(taskId, (plan) => chooseOption(plan, stepId, optionKey)),
      });
    }),
  );
}
