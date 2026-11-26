import { and, asc, eq, inArray } from "drizzle-orm";
import { Context, Deferred, Effect, Layer, Option, Ref } from "effect";
import { Database } from "../db/database.js";
import { agentRuns } from "../db/schema.js";
import type { ItemState } from "../source/source-item.js";
import { TaskRepository } from "../task/task-repository.js";
import { deriveTaskStatus } from "../task/task-status.js";
import type { TaskStatus } from "../task/task.js";
import { ClaudeCodeError, StopNotice } from "./claude-code.js";

const noticeOf = (states: readonly ItemState[]) =>
  states.includes("resolved") ? "追っている項目（PR など）が merge・close された" : "追っている項目が消えた（削除された、または見られなくなった）";

/**
 * 処理中の Task へ、追う項目が片付いたことを知らせる受け口。
 * 動いている処理（Claude Code）には知らせて、作業をやめるか続けるかを判断させる。待ち行列にあるだけの処理は取り消す
 */
export class RunInterrupts extends Context.Service<RunInterrupts, {
  /** effect を動かしている間、その Task への知らせを StopNotice で受け取れるようにする */
  listen<A, E, R>(taskId: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, StopNotice>>;
  /** 処理中の Task の追う項目の状態が変わった。知らせるか取り消すかしたら true */
  trackedClosed(taskId: number, states: readonly ItemState[]): Effect.Effect<boolean>;
}>()("live-todo/core/agent/RunInterrupts") {
  static readonly layer = Layer.effect(
    RunInterrupts,
    Effect.gen(function* () {
      const db = yield* Database;
      const tasks = yield* TaskRepository;
      const listeners = yield* Ref.make(new Map<number, ReadonlySet<Deferred.Deferred<string>>>());

      const update = (taskId: number, change: (current: ReadonlySet<Deferred.Deferred<string>>) => ReadonlySet<Deferred.Deferred<string>>) =>
        Ref.update(listeners, (all) => {
          const next = new Map(all);
          const set = change(all.get(taskId) ?? new Set());
          if (set.size === 0) next.delete(taskId);
          else next.set(taskId, set);
          return next;
        });

      const listen = <A, E, R>(taskId: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, StopNotice>> =>
        Effect.acquireUseRelease(
          Effect.tap(Deferred.make<string>(), (deferred) => update(taskId, (current) => new Set([...current, deferred]))),
          (deferred) =>
            effect.pipe(
              Effect.provideService(StopNotice, {
                wait: Deferred.await(deferred),
                poll: Effect.flatMap(Deferred.poll(deferred), (done) => (Option.isSome(done) ? Effect.map(done.value, Option.some) : Effect.succeedNone)),
              }),
            ),
          (deferred) => update(taskId, (current) => new Set([...current].filter((entry) => entry !== deferred))),
        );

      // 待ち行列の処理はまだ何も作業していないので、判断させずに取り消し、追う項目から status を導き直す
      const cancelQueued = Effect.fnUntraced(function* (taskId: number, states: readonly ItemState[]) {
        const active = yield* db
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.taskId, taskId), inArray(agentRuns.status, ["queued", "running"])))
          .orderBy(asc(agentRuns.id))
          .pipe(Effect.orDie);
        const queued = active.filter((run) => run.status === "queued");
        if (queued.length === 0) return false;
        yield* db.delete(agentRuns).where(inArray(agentRuns.id, queued.map((run) => run.id))).pipe(Effect.orDie);
        if (active.some((run) => run.status === "running")) return true;
        const task = yield* tasks.findTask(taskId);
        if (Option.isNone(task) || task.value.status !== "agent_running") return true;
        const next = deriveTaskStatus(queued[0]!.previousStatus as TaskStatus, states);
        yield* tasks.updateTask(taskId, { status: next });
        yield* tasks.recordChange(taskId, { kind: "field_changed", field: "status", before: "agent_running", after: next, unread: true, actor: "agent" });
        return true;
      });

      const trackedClosed = Effect.fn("RunInterrupts.trackedClosed")(function* (taskId: number, states: readonly ItemState[]) {
        if (states.length === 0 || states.includes("open")) return false;
        const cancelled = yield* cancelQueued(taskId, states);
        const waiting = (yield* Ref.get(listeners)).get(taskId) ?? new Set();
        for (const deferred of waiting) yield* Deferred.succeed(deferred, noticeOf(states));
        return cancelled || waiting.size > 0;
      });

      return RunInterrupts.of({ listen, trackedClosed });
    }),
  );
}

/** RunInterrupts があれば、effect を動かしている間その Task への知らせを受け取る（ないときはそのまま動かす） */
export const listenForStop =
  (taskId: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, StopNotice>> =>
    Effect.flatMap(Effect.serviceOption(RunInterrupts), (interrupts) =>
      Option.isSome(interrupts) ? interrupts.value.listen(taskId, effect) : (effect as Effect.Effect<A, E, Exclude<R, StopNotice>>),
    );

export const isStopped = (error: unknown): error is ClaudeCodeError => error instanceof ClaudeCodeError && error.stoppedReason !== undefined;

/** 処理が終わったあとに戻す status。作業をやめたなら追う項目の今の状態から導き直し、それ以外は処理前の status に戻す */
export const statusAfterRun = Effect.fnUntraced(function* (taskId: number, previousStatus: TaskStatus, failure: unknown) {
  if (!isStopped(failure)) return previousStatus;
  return deriveTaskStatus(previousStatus, yield* (yield* TaskRepository).trackedItemStates(taskId));
});
