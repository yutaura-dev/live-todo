import { withdraw as withdrawEffect } from "../../domain/completion-effect/completion-effect.js";
import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Option } from "effect";
import { complete, defineCompletionByHand, dismiss, markOf, reopen, setDue, type Task, create, view, noteEffects } from "../../domain/task/task.js";
import type { Prioritization } from "../../domain/priority/prioritization.js";
import { PrioritizationStore } from "../../store/prioritization-store.js";
import { SourceItemStore } from "../../store/source-item-store.js";
import { TaskStore } from "../../store/task-store.js";
import type { SourceItem } from "../../domain/source-item/source-item.js";
import { factViewOf, sourceOf } from "./materials.js";
import type { BoardCard, Command, PriorityView, Reply, TaskView } from "../shared/api.js";
import { Prioritizer } from "./prioritizer.js";
import { Planner } from "./plan/planner.js";
import { type PlanGroup, turnsOf, effectsOf, replaceEffect } from "../../domain/plan/plan.js";
import type { PlanRow } from "../shared/api.js";

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

/** 完了したときにすることがまだあれば、完了にすると完了待ちになる */
export const effectsFact = (task: Task) =>
  task.plan !== null && effectsOf(task.plan).some((effect) => effect.delivery === "まだ") ? ("完了したときにすることがある" as const) : ("完了したときにすることがない" as const);
/** 書き込みを頼んで結果を待っているものがあれば、やらない・やり直すはできない（宙に浮かないように） */
export const inFlightOf = (task: Task) => (task.plan !== null && effectsOf(task.plan).some((effect) => effect.delivery === "頼んだ") ? ("頼んだものがある" as const) : ("頼んだものはない" as const));
/** やらないことにしたら、まだ頼んでいない・書き込めなかった完了したときにすることを取りやめる */
export const withdrawEffects = (task: Task) =>
  Effect.gen(function* () {
    if (task.plan === null) return task;
    let plan = task.plan;
    for (const effect of effectsOf(plan)) {
      const withdrawn = yield* withdrawEffect(effect, { kind: "app" }).pipe(Effect.option);
      if (Option.isSome(withdrawn)) plan = replaceEffect(plan, withdrawn.value);
    }
    return plan === task.plan ? task : yield* noteEffects(task, { kind: "app" }, plan, "取りやめた");
  });
const NOT_FOUND = "Task が見つかりません";

const priorityOf = (p: Prioritization | undefined): PriorityView =>
  p === undefined ? { status: "未判定", level: null, reason: null } : { status: p.status, level: p.priority?.level ?? null, reason: p.priority?.reason ?? null };

/** 計画の木を、字下げ付きの行の並びにする（画面はこの順に並べる） */
export function planRowsOf(plan: PlanGroup): PlanRow[] {
  const turns = turnsOf(plan);
  const rows: PlanRow[] = [];
  const walk = (group: PlanGroup, depth: number) => {
    for (const node of group.nodes) {
      if (node.type === "group") {
        rows.push({ kind: "group", id: `group-${rows.length}`, title: node.group.arrangement === "parallel" ? "同時に進める" : "順に進める", depth, turn: null, completes: false, how: null, options: [], chosen: null, added: false });
        walk(node.group, depth + 1);
      } else if (node.type === "branch") {
        rows.push({ kind: "branch", id: `branch-${node.decisionId}`, title: `「${node.option}」を選んだ${node.plan === null ? "（AI が先の計画を考えています）" : ""}`, depth, turn: null, completes: false, how: null, options: [], chosen: null, added: false });
        if (node.plan !== null && node.state === "進めている") walk(node.plan, depth + 1);
      } else if (node.type === "item") {
        const { item } = node;
        const how = item.definition.how;
        rows.push({
          kind: how.type === "decision" ? "decision" : "item",
          id: item.id,
          title: how.type === "decision" ? how.question : item.definition.title,
          depth,
          turn: turns.get(item.id) ?? null,
          completes: item.definition.completes,
          how: how.type,
          options: how.type === "decision" ? how.options.map((option) => option.label) : [],
          chosen: item.chosen ?? null,
          added: item.addedFrom !== null,
        });
      }
    }
  };
  walk(plan, 0);
  return rows;
}

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
  plan: task.plan === null ? null : planRowsOf(task.plan),
  effects: task.plan === null ? [] : effectsOf(task.plan).map((effect) => ({ id: effect.id, title: effect.title, checked: effect.checked, delivery: effect.delivery })),
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
      const planner = yield* Planner;
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

      // 計画は Planner が保存するので、ここでは読み直して知らせるだけ
      const afterPlan = (id: string) =>
        Effect.gen(function* () {
          const found = yield* store.find(id);
          if (Option.isNone(found)) return failed(NOT_FOUND);
          yield* notify(id);
          return { ok: true, value: yield* viewOf(found.value) } as Reply<TaskView>;
        });

      const completionFacts = (task: Task) => ({ effects: effectsFact(task), added: "足した項目はすべて済んだ" }) as const;

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
              return yield* apply(input.id, (task) => complete(task, user, "自分で完了にした", completionFacts(task)));
            case "DismissTask":
              return yield* apply(input.id, (task) => Effect.flatMap(dismiss(task, user, "自分で片付けた", inFlightOf(task)), withdrawEffects));
            case "ReopenTask": {
              const reply = yield* apply(input.id, (task) => reopen(task, user, inFlightOf(task)));
              // やり直したら、計画を立て直す（前の Action Item は済んだまま残るので、そのままでは二度と自動で終わらないため。task.spec）
              if (!reply.ok) return reply;
              const reopened = yield* store.find(input.id);
              if (Option.isSome(reopened) && reopened.value.plan !== null) yield* planner.revise(reopened.value);
              return yield* afterPlan(input.id);
            }
            case "RevisePlan": {
              const found = yield* store.find(input.id);
              if (Option.isNone(found)) return failed(NOT_FOUND);
              const reply = yield* planner.revise(found.value);
              return reply.ok ? yield* afterPlan(input.id) : failed(reply.reason);
            }
            case "PlanAction": {
              const reply = yield* planner.act(input.id, input.action);
              return reply.ok ? yield* afterPlan(input.id) : failed(reply.reason);
            }
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
