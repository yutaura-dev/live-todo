import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Option } from "effect";
import { complete, defineCompletionByHand, dismiss, markOf, reopen, setDue, type Task, create, view } from "../../domain/task/task.js";
import type { Prioritization } from "../../domain/priority/prioritization.js";
import { PrioritizationStore } from "../../store/prioritization-store.js";
import { SourceItemStore } from "../../store/source-item-store.js";
import { TaskStore } from "../../store/task-store.js";
import type { SourceItem } from "../../domain/source-item/source-item.js";
import { factViewOf, sourceOf } from "./materials.js";
import type { BoardCard, Command, PriorityView, Reply, TaskView } from "../shared/api.js";
import { Prioritizer } from "./prioritizer.js";

export class TaskIds extends Context.Service<TaskIds, { readonly next: Effect.Effect<string> }>()("live-todo/desktop/TaskIds") {
  static readonly random = Layer.succeed(TaskIds, TaskIds.of({ next: Effect.sync(() => randomUUID()) }));
}

/** テスト用。t1, t2, … と順に振る */
export const sequentialIds = (prefix: string) =>
  Layer.sync(TaskIds, () => {
    let n = 0;
    return TaskIds.of({ next: Effect.sync(() => `${prefix}${++n}`) });
  });

const user = { kind: "user" } as const;
const NOT_FOUND = "Task が見つかりません";

const priorityOf = (p: Prioritization | undefined): PriorityView =>
  p === undefined ? { status: "未判定", level: null, reason: null } : { status: p.status, level: p.priority?.level ?? null, reason: p.priority?.reason ?? null };

const toView = (task: Task, p: Prioritization | undefined, facts: ReadonlyArray<SourceItem>): TaskView => ({
  id: task.id,
  title: task.title,
  brief: task.brief,
  status: task.status,
  completion: task.completion,
  closure: task.closure,
  due: task.due,
  mark: markOf(task),
  priority: priorityOf(p),
  facts: facts.map(factViewOf),
  history: task.history,
  createdAt: task.createdAt,
});

const toCard = (task: Task, p: Prioritization | undefined, facts: ReadonlyArray<SourceItem>): BoardCard => ({
  id: task.id,
  title: task.title,
  status: task.status,
  mark: markOf(task),
  due: task.due?.text ?? null,
  blocksOthers: task.blocksOthers,
  priority: priorityOf(p),
  sources: [...new Set(facts.map((fact) => sourceOf(fact.uri)))],
});

const failed = (reason: string): Reply<never> => ({ ok: false, reason });

/**
 * 画面からの操作を、ユーザーの操作として Task に当てて保存する。断られた理由は spec の文のまま返す。
 * 完了したときにすること・書き込みの頼みはまだないので、complete・dismiss・reopen にはそれがない前提を渡す（Completion Effect の縦の一本で、実際の状態に置き換える）。
 */
export class TaskService extends Context.Service<
  TaskService,
  {
    command(command: Command): Effect.Effect<Reply<TaskView>>;
    board(): Effect.Effect<Reply<ReadonlyArray<BoardCard>>>;
    task(id: string): Effect.Effect<Reply<TaskView>>;
    onChanged(listener: (taskId: string) => void): Effect.Effect<void>;
    /** 開いている Task の優先度を、今日の日付で決め直す（日が変わったとき・起動したとき） */
    refreshAll(): Effect.Effect<void>;
    /** ほかの口（取り込み・提案）で Task が変わったことを、画面に知らせる */
    notify(taskId: string): Effect.Effect<void>;
  }
>()("live-todo/desktop/TaskService") {
  static readonly layer = Layer.effect(
    TaskService,
    Effect.gen(function* () {
      const store = yield* TaskStore;
      const priorities = yield* PrioritizationStore;
      const items = yield* SourceItemStore;
      const prioritizer = yield* Prioritizer;
      const ids = yield* TaskIds;
      const notify = (id: string) => Effect.sync(() => listeners.forEach((listener) => listener(id)));
      const viewOf = (task: Task) =>
        Effect.gen(function* () {
          const p = yield* priorities.find(task.id);
          const facts = yield* items.findMany(task.sourceItemIds);
          return toView(task, Option.getOrUndefined(p), facts);
        });
      // 優先度を決め直して出来事を足し、Task と一緒に保存する（spec の links: Task の操作 → 優先度）
      const settle = (task: Task) =>
        Effect.gen(function* () {
          const prioritized = yield* prioritizer.refresh(task);
          yield* store.save(prioritized);
          yield* notify(prioritized.id);
          return { ok: true, value: yield* viewOf(prioritized) } as Reply<TaskView>;
        });
      const listeners: Array<(taskId: string) => void> = [];

      const apply = (id: string, change: (task: Task) => Effect.Effect<Task, { readonly reason: string }>) =>
        Effect.gen(function* () {
          const found = yield* store.find(id);
          if (Option.isNone(found)) return failed(NOT_FOUND);
          return yield* change(found.value).pipe(
            Effect.matchEffect({ onFailure: (error) => Effect.succeed(failed(error.reason)), onSuccess: settle }),
          );
        });

      // 優先度の操作は Prioritizer が優先度を保存し、出来事を足した Task を返す
      const applyPriority = (id: string, change: (task: Task) => Effect.Effect<Task, { readonly reason: string } | { readonly _tag: "StoreCorrupted" }>) =>
        Effect.gen(function* () {
          const found = yield* store.find(id);
          if (Option.isNone(found)) return failed(NOT_FOUND);
          return yield* change(found.value).pipe(
            Effect.matchEffect({
              onFailure: (error) => Effect.succeed(failed("reason" in error ? error.reason : "保存した Task を読めませんでした")),
              onSuccess: (task) =>
                Effect.gen(function* () {
                  yield* store.save(task);
                  yield* notify(task.id);
                  return { ok: true, value: yield* viewOf(task) } as Reply<TaskView>;
                }),
            }),
          );
        });

      const nothingPending = { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" } as const;

      const command = (input: Command): Effect.Effect<Reply<TaskView>> =>
        Effect.gen(function* () {
          switch (input._tag) {
            case "CreateTask": {
              const id = yield* ids.next;
              return yield* create({ id, title: input.title, brief: input.brief, actor: user, origin: "手で足した" }).pipe(
                Effect.tap((task) => store.save(task)),
                Effect.matchEffect({ onFailure: (error) => Effect.succeed(failed(error.reason)), onSuccess: settle }),
              );
            }
            case "CompleteTask":
              return yield* apply(input.id, (task) => complete(task, user, "自分で完了にした", nothingPending));
            case "DismissTask":
              return yield* apply(input.id, (task) => dismiss(task, user, "自分で片付けた", "頼んだものはない"));
            case "ReopenTask":
              return yield* apply(input.id, (task) => reopen(task, user, "頼んだものはない"));
            case "SetDue":
              return yield* apply(input.id, (task) => setDue(task, user, input.due));
            case "DefineCompletion":
              return yield* apply(input.id, (task) => defineCompletionByHand(task, user));
            case "ViewTask":
              return yield* apply(input.id, (task) => view(task, user));
            case "SetPriority":
              return yield* applyPriority(input.id, (task) => prioritizer.setByUser(task, input.level));
            case "ClearPriority":
              return yield* applyPriority(input.id, (task) => prioritizer.clearByUser(task));
          }
        }).pipe(Effect.catchTag("StoreCorrupted", () => Effect.succeed(failed("保存した Task を読めませんでした"))));

      const board = () =>
        Effect.gen(function* () {
          const tasks = yield* store.listForBoard();
          const byTask = new Map((yield* priorities.all()).map((p) => [p.taskId, p]));
          const facts = new Map((yield* items.findMany([...new Set(tasks.flatMap((task) => task.sourceItemIds))])).map((item) => [item.id, item]));
          const factsOf = (task: Task) => task.sourceItemIds.flatMap((id) => (facts.has(id) ? [facts.get(id)!] : []));
          return { ok: true, value: tasks.map((task) => toCard(task, byTask.get(task.id), factsOf(task))) } as Reply<ReadonlyArray<BoardCard>>;
        }).pipe(
          Effect.catchTag("StoreCorrupted", () => Effect.succeed(failed("保存した Task を読めませんでした"))),
        );

      const task = (id: string) =>
        store.find(id).pipe(
          Effect.flatMap((found) => (Option.isSome(found) ? Effect.map(viewOf(found.value), (value): Reply<TaskView> => ({ ok: true, value })) : Effect.succeed(failed(NOT_FOUND)))),
          Effect.catchTag("StoreCorrupted", () => Effect.succeed(failed("保存した Task を読めませんでした"))),
        );

      const onChanged = (listener: (taskId: string) => void) => Effect.sync(() => void listeners.push(listener));

      const refreshAll = () =>
        Effect.gen(function* () {
          for (const open of (yield* store.listForBoard()).filter((t) => t.status === "やること")) {
            const prioritized = yield* prioritizer.refresh(open);
            if (prioritized !== open) {
              yield* store.save(prioritized);
              yield* notify(prioritized.id);
            }
          }
        }).pipe(Effect.catchTag("StoreCorrupted", (error) => Effect.logWarning("優先度を決め直せない Task がある").pipe(Effect.annotateLogs({ taskId: error.taskId }))));

      return TaskService.of({ command, board, task, onChanged, refreshAll, notify });
    }),
  );
}
