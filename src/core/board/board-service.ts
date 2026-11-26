import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Database } from "../db/database.js";
import { agentRuns, sourceItems, taskLinks } from "../db/schema.js";
import { TaskRepository, type TaskWithUnread } from "../task/task-repository.js";
import type { TaskStatus } from "../task/task.js";
import { chooseOption, completeStep, currentSteps, isWaitingOnly, reopenStep, decodePlan, EFFORTS, type Effort, type NextActionPlan, taskEffort } from "../task/next-actions.js";

export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()("TaskNotFoundError", {
  taskId: Schema.Number,
}) {}

export const BOARD_COLUMNS = [
  { id: "needs_review", title: "要確認" },
  { id: "agent_running", title: "処理中" },
  { id: "todo", title: "Todo" },
  // Task の状態ではなく、いま着手できるのが待つ手順だけの Task（Todo・進行中）を出し分ける列
  { id: "waiting", title: "待ち" },
  { id: "in_progress", title: "進行中" },
  { id: "done", title: "完了" },
] as const satisfies ReadonlyArray<{ id: TaskStatus | "waiting"; title: string }>;

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
  /** Task の難易度（いま着手できる手順のうち、いちばん手間の少ないもの） */
  effort?: Effort;
  /** いま着手できる次にやることと、その手間 */
  nextActions?: ReadonlyArray<{ title: string; effort: Effort; kind: string }>;
  /** AI が調査中のレーンにあるとき、調べている最中か、調査待ちの何番目か */
  agent?: { state: "running"; kind: string } | { state: "queued"; kind: string; position: number };
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
  /** 依存更新の調査（最後に成功したもの。調べている最中・調査待ちならそれ） */
  agentRun?: TaskDetailAgentRun;
  /** 成功した調査のあとの調べ直しが失敗していたら、その理由 */
  agentRunProblem?: string;
  /** 次にやること（手順の並び全体） */
  nextActions?: NextActionPlan;
  /** いま着手できる手順の id */
  currentStepIds?: string[];
  /** AI が「定期の Task にした方がよい」と提案したときの下書き */
  recurringSuggestion?: RecurringSuggestion;
  /** 定期の Task から作った Task か（その Task から定期の Task は作らない） */
  fromRecurring: boolean;
};

export type RecurringSuggestion = { day: number; leadDays: number; title: string; note: string; reason: string };
const RecurringSuggestionSchema = Schema.Struct({ day: Schema.Number, leadDays: Schema.Number, title: Schema.String, note: Schema.String, reason: Schema.String });

/** 処理中のレーンへの出入りは、調べ直すたびに起きる裏の動きなので履歴に出さない。値の変わらない変更も出さない */
const isMeaningfulChange = (change: { kind: string; field: string | null; before: unknown; after: unknown }) =>
  !(change.kind === "field_changed" && change.field === "status" && (change.before === "agent_running" || change.after === "agent_running")) &&
  !(change.kind === "field_changed" && JSON.stringify(change.before) === JSON.stringify(change.after));

export type Board = { columns: ReadonlyArray<{ id: BoardColumnId; title: string; cards: BoardCard[] }> };

// 完了の列は増え続けるので、新しいものから一定数だけ出す
const DONE_COLUMN_LIMIT = 50;

const StoredJudgment = Schema.Struct({
  method: Schema.String,
  probability: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
});
const decodeJudgment = Schema.decodeUnknownOption(StoredJudgment);

const effortRank = (card: { effort?: Effort }) => (card.effort === undefined ? EFFORTS.length : EFFORTS.indexOf(card.effort));

// 更新した時刻で並べない理由: 同期はカードに見えない書き換え（状況の件名の一覧・手順の通数など）でも時刻を進めるので、
// 理由の見えないままカードが動く。動くのは、カードに見えている変化（更新マーク・手間）があったときだけにする
const byAttention = (a: TaskWithUnread, b: TaskWithUnread) =>
  Number(b.unreadChanges > 0) - Number(a.unreadChanges > 0) || b.createdAt.localeCompare(a.createdAt) || b.id - a.id;

export class InvalidTaskInputError extends Schema.TaggedError<InvalidTaskInputError>()("InvalidTaskInputError", { message: Schema.String }) {}

export class BoardService extends Context.Service<BoardService, {
  readonly board: Effect.Effect<Board>;
  /** ユーザーがカードを動かした。ユーザーの操作として記録し、判定の正解として集められるようにする */
  moveTask(taskId: number, status: TaskStatus): Effect.Effect<void, TaskNotFoundError>;
  markSeen(taskId: number): Effect.Effect<void>;
  taskDetail(taskId: number): Effect.Effect<TaskDetail, TaskNotFoundError>;
  completeStep(taskId: number, stepId: string): Effect.Effect<void, TaskNotFoundError>;
  chooseOption(taskId: number, stepId: string, optionKey: string): Effect.Effect<void, TaskNotFoundError>;
  /** 済んだにした手順・選んだ分かれ道を戻す（押し間違えたとき） */
  reopenStep(taskId: number, stepId: string): Effect.Effect<void, TaskNotFoundError>;
  /** Task を手で追加する（元の項目のない Task）。作った Task の id */
  addTask(input: { title: string; brief?: string }): Effect.Effect<number, InvalidTaskInputError>;
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
        .select({ taskId: agentRuns.taskId, status: agentRuns.status, kind: agentRuns.kind })
        .from(agentRuns)
        .where(inArray(agentRuns.status, ["queued", "running"]))
        .orderBy(asc(agentRuns.id))
        .pipe(Effect.orDie);

      const board = Effect.gen(function* () {
        const all = yield* tasks.listTasks;
        const agentOf = new Map<number, NonNullable<BoardCard["agent"]>>();
        let position = 0;
        for (const run of yield* activeRuns) {
          agentOf.set(run.taskId, run.status === "running" ? { state: "running", kind: run.kind } : { state: "queued", kind: run.kind, position: ++position });
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
              onSome: (plan) => {
                const effort = taskEffort(plan);
                return {
                  nextActions: currentSteps(plan).map((step) => ({ title: step.title, effort: step.effort, kind: step.kind })),
                  ...(effort === undefined ? {} : { effort }),
                };
              },
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
            const isWaiting = (task: TaskWithUnread) =>
              (task.status === "todo" || task.status === "in_progress") && Option.match(decodePlan(task.nextActions), { onNone: () => false, onSome: isWaitingOnly });
            const inColumn = (task: TaskWithUnread) => (column.id === "waiting" ? isWaiting(task) : task.status === column.id && !isWaiting(task));
            const cards = all.filter(inColumn).toSorted(byAttention).map(toCard);
            // Todo は、すぐ片付くものから手を付けられるよう、難易度の低い順に並べる（次にやることがないものは最後）
            if (column.id === "todo") cards.sort((a, b) => effortRank(a) - effortRank(b));
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
        // 依存更新の調査の結果を出す。最後の調べ直しが失敗していても、成功した調査の結論を出し、失敗は添えるだけにする
        const reviewRuns = yield* db
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.kind, "dependency_review")))
          .orderBy(desc(agentRuns.id))
          .pipe(Effect.orDie);
        const latest = reviewRuns[0];
        const latestSucceeded = reviewRuns.find((candidate) => candidate.status === "succeeded");
        const lastRun = latest !== undefined && latest.status !== "failed" ? latest : (latestSucceeded ?? latest);
        const agentRunProblem = latest?.status === "failed" && latestSucceeded !== undefined ? (latest.error ?? "理由不明") : undefined;

        return {
          id: task.id,
          title: task.title,
          brief: task.brief,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          items: itemRows.map((row) => ({ ...row, judgment: toJudgment(row.judgment) })),
          changes: changes.toReversed().filter(isMeaningfulChange).map((change) => ({
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
          ...(agentRunProblem === undefined ? {} : { agentRunProblem }),
          ...Option.match(Schema.decodeUnknownOption(RecurringSuggestionSchema)(task.recurringSuggestion), {
            onNone: () => ({}),
            onSome: (recurringSuggestion) => ({ recurringSuggestion }),
          }),
          fromRecurring: task.recurringTaskId !== null,
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
        yield* tasks.updateTask(taskId, { nextActions: change(plan.value) }, "user");
      });

      return BoardService.of({
        board,
        moveTask,
        markSeen: tasks.markChangesSeen,
        taskDetail,
        completeStep: (taskId, stepId) => updatePlan(taskId, (plan) => completeStep(plan, stepId)),
        chooseOption: (taskId, stepId, optionKey) => updatePlan(taskId, (plan) => chooseOption(plan, stepId, optionKey)),
        reopenStep: (taskId, stepId) => updatePlan(taskId, (plan) => reopenStep(plan, stepId)),
        addTask: (input) =>
          Effect.gen(function* () {
            const title = input.title.trim();
            if (title === "") return yield* new InvalidTaskInputError({ message: "タイトルが空" });
            const task = yield* tasks.createTask({ title, status: "todo" });
            const brief = input.brief?.trim() ?? "";
            if (brief !== "") yield* tasks.updateTask(task.id, { brief }, "user");
            yield* tasks.recordChange(task.id, { kind: "created", after: { manual: true }, unread: false, actor: "user" });
            return task.id;
          }),
      });
    }),
  );
}
