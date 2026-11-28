import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Option } from "effect";
import { complete, defineCompletionByHand, dismiss, markOf, reopen, setDue, type Task, create, view } from "../../domain/task/task.js";
import { TaskStore } from "../../store/task-store.js";
import type { BoardCard, Command, Reply, TaskView } from "../shared/api.js";

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

const toView = (task: Task): TaskView => ({
  id: task.id,
  title: task.title,
  brief: task.brief,
  status: task.status,
  completion: task.completion,
  closure: task.closure,
  due: task.due,
  mark: markOf(task),
  history: task.history,
  createdAt: task.createdAt,
});

const toCard = (task: Task): BoardCard => ({ id: task.id, title: task.title, status: task.status, mark: markOf(task), due: task.due?.text ?? null });

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
  }
>()("live-todo/desktop/TaskService") {
  static readonly layer = Layer.effect(
    TaskService,
    Effect.gen(function* () {
      const store = yield* TaskStore;
      const ids = yield* TaskIds;
      const listeners: Array<(taskId: string) => void> = [];

      const apply = (id: string, change: (task: Task) => Effect.Effect<Task, { readonly reason: string }>) =>
        Effect.gen(function* () {
          const found = yield* store.find(id);
          if (Option.isNone(found)) return failed(NOT_FOUND);
          return yield* change(found.value).pipe(
            Effect.tap((task) => store.save(task)),
            Effect.tap((task) => Effect.sync(() => listeners.forEach((listener) => listener(task.id)))),
            Effect.map((task): Reply<TaskView> => ({ ok: true, value: toView(task) })),
            Effect.catch((error) => Effect.succeed(failed(error.reason))),
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
                Effect.tap((task) => Effect.sync(() => listeners.forEach((listener) => listener(task.id)))),
                Effect.map((task): Reply<TaskView> => ({ ok: true, value: toView(task) })),
                Effect.catch((error) => Effect.succeed(failed(error.reason))),
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
          }
        }).pipe(Effect.catchTag("StoreCorrupted", () => Effect.succeed(failed("保存した Task を読めませんでした"))));

      const board = () =>
        store.listForBoard().pipe(
          Effect.map((tasks): Reply<ReadonlyArray<BoardCard>> => ({ ok: true, value: tasks.map(toCard) })),
          Effect.catchTag("StoreCorrupted", () => Effect.succeed(failed("保存した Task を読めませんでした"))),
        );

      const task = (id: string) =>
        store.find(id).pipe(
          Effect.map((found): Reply<TaskView> => (Option.isSome(found) ? { ok: true, value: toView(found.value) } : failed(NOT_FOUND))),
          Effect.catchTag("StoreCorrupted", () => Effect.succeed(failed("保存した Task を読めませんでした"))),
        );

      const onChanged = (listener: (taskId: string) => void) => Effect.sync(() => void listeners.push(listener));

      return TaskService.of({ command, board, task, onChanged });
    }),
  );
}
