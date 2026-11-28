import { Context, Effect, Fiber, Layer, Option, Stream } from "effect";
import {
  type AgentRun,
  type AgentRunKind,
  cancel as cancelRun,
  fail as failRun,
  isActiveRun,
  isOpenRun,
  requestRun,
  start as startRun,
  stop as stopRun,
  succeed as succeedRun,
  withdraw as withdrawRun,
} from "../../../domain/agent/agent-run.js";
import { AgentThread, lose, openThread, renew } from "../../../domain/agent/agent-thread.js";
import { allowed, limitOf } from "../../../domain/autonomy/autonomy-policy.js";
import { agentRunOf, autoStartAgent, itemsOf, requestAgent, succeedByAgent, turnOf } from "../../../domain/plan/plan.js";
import { noteWork, receive, type Task } from "../../../domain/task/task.js";
import { type AgentEvent, AgentRunner, type AgentRunRequest } from "../../../llm/agent/agent.js";
import { rewriteTaskWriting } from "../../../llm/generation/writings/index.js";
import type { AgentOutcome } from "../../../llm/shared/materials.js";
import { DocumentStore, documentsOf } from "../../../store/document-store.js";
import { agentRuns, agentRunViewOf as viewOf, runsOfTask } from "./agent-runs.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { type StoreCorrupted, TaskStore } from "../../../store/task-store.js";
import type { AgentRunView, Reply } from "../../shared/api.js";
import { AiServices } from "../ai/ai-services.js";
import { taskMaterialOf } from "../materials.js";
import { Planner } from "../plan/planner.js";
import { Prioritizer } from "../prioritizer.js";
import { TaskIds } from "../task-service.js";
import { currentPolicy } from "../writes/write-service.js";
import { AGENT_OPERATIONS } from "./agent-operations.js";

export { agentRuns };
const threads = documentsOf("agent-thread", AgentThread);

const user = { kind: "user" } as const;
const agent = { kind: "agent" } as const;
const app = { kind: "app" } as const;
const UNSURE = "AI の作業の成果が届いた。確かめる";
const FIX_NOT_READY = "直す作業は、作業場所を用意できるようになるまで頼めません";
const PROGRESS_LINES = 20;
const PROGRESS_CHARS = 300;

const textOf = (outcome: AgentOutcome) =>
  outcome.type === "回答" ? outcome.text : outcome.type === "報告" ? [outcome.summary, ...outcome.findings.map((f) => `- ${f}`)].join("\n") : outcome.summary;

/**
 * Task について Claude Code に頼む作業（agent-run.spec・agent-thread.spec）。Agent は Task を直接変えず、成果は「AI の作業の成果」として Task に届く。
 * 外へは書き込まない（渡す道具は読むだけ。外への書き込みが要るなら、Generation が計画に書き込みの Action Item を足し、Approval を通す）。
 */
export class AgentService extends Context.Service<
  AgentService,
  {
    /** ユーザーが質問を頼む（読むだけ） */
    ask(taskId: string, request: string): Effect.Effect<Reply<AgentRunView>, StoreCorrupted>;
    /** 計画の Claude Code の Action Item を、ボタンで頼む */
    requestFromItem(taskId: string, itemId: string): Effect.Effect<Reply<AgentRunView>, StoreCorrupted>;
    stop(runId: string): Effect.Effect<Reply<null>, StoreCorrupted>;
    cancel(runId: string): Effect.Effect<Reply<null>, StoreCorrupted>;
    runsOf(taskId: string): Effect.Effect<ReadonlyArray<AgentRunView>, StoreCorrupted>;
    /** 番が来た「自動でやる」Claude Code の Action Item のうち、自動でやってよい範囲に入るものを頼む。頼んだ Task の ID を返す */
    autoStart(): Effect.Effect<ReadonlyArray<string>, StoreCorrupted>;
    /** 計画が進んだあとに、要らなくなった作業をやめ、やり遂げていた作業で番が来た Action Item を果たす */
    settleFinished(taskId: string): Effect.Effect<void, StoreCorrupted>;
    /** 待ち行列の作業を、Task ごとに 1 つずつ動かす（返した fiber は、その Task の待ち行列が空になると終わる） */
    pump(): Effect.Effect<ReadonlyArray<Fiber.Fiber<void, never>>, StoreCorrupted>;
    /** 起動したとき、やっているまま残っていた作業を、アプリを閉じたので止まったにする */
    recover(): Effect.Effect<void, StoreCorrupted>;
    /** 作業が進んだ・終わったことを画面に知らせる（答えはあとから届くので） */
    onChanged(listener: (taskId: string) => void): Effect.Effect<void>;
  }
>()("live-todo/desktop/AgentService") {
  static readonly layer = Layer.effect(
    AgentService,
    Effect.gen(function* () {
      const tasks = yield* TaskStore;
      const items = yield* SourceItemStore;
      const ai = yield* AiServices;
      const runner = yield* AgentRunner;
      const planner = yield* Planner;
      const prioritizer = yield* Prioritizer;
      const ids = yield* TaskIds;
      const docs = yield* DocumentStore;
      const consumers = new Map<string, Fiber.Fiber<void, unknown>>();
      const draining = new Set<string>();
      const listeners: Array<(taskId: string) => void> = [];
      const changed = (taskId: string) => Effect.sync(() => listeners.forEach((listener) => listener(taskId)));

      const openOf = (task: Task) => (task.status === "やること" ? "開いている" : "開いていない") as "開いている" | "開いていない";
      const causeOf = (run: AgentRun) => `agent-run:${run.id}`;

      const note = (taskId: string, what: "始まった" | "終わった" | "やめた", run: AgentRun) =>
        Effect.gen(function* () {
          const task = yield* tasks.find(taskId);
          if (Option.isNone(task)) return;
          const next = yield* noteWork(task.value, app, what, causeOf(run)).pipe(Effect.option);
          if (Option.isSome(next)) yield* tasks.save(next.value);
          yield* changed(taskId);
        });

      const ask = (taskId: string, request: string) =>
        Effect.gen(function* () {
          const task = yield* tasks.find(taskId);
          if (Option.isNone(task)) return { ok: false, reason: "Task が見つかりません" } as const;
          const run = yield* requestRun(user, "質問に答える", openOf(task.value), { id: yield* ids.next, taskId, request, actionItemId: null, subjectFingerprint: null }).pipe(Effect.result);
          if (run._tag === "Failure") return { ok: false, reason: run.failure.reason } as const;
          yield* agentRuns.save(run.success);
          return { ok: true, value: viewOf(run.success) } as const;
        });

      const openRunsOfItem = (itemId: string) => Effect.map(agentRuns.all(), (all) => all.filter((run) => run.actionItemId === itemId && isOpenRun(run)));

      const requestFromItem = (taskId: string, itemId: string) =>
        Effect.gen(function* () {
          const task = yield* tasks.find(taskId);
          if (Option.isNone(task) || task.value.plan === null) return { ok: false, reason: "Task が見つかりません" } as const;
          const item = itemsOf(task.value.plan).find((entry) => entry.id === itemId);
          const runId = yield* ids.next;
          const running = (yield* openRunsOfItem(itemId)).length > 0 ? "終わっていない作業がある" : "終わっていない作業はない";
          const plan = yield* requestAgent(task.value.plan, itemId, user, { running, task: openOf(task.value) }, runId).pipe(Effect.result);
          if (plan._tag === "Failure") return { ok: false, reason: plan.failure.reason } as const;
          const how = item?.definition.how;
          if (how?.type === "claude" && how.tools === "直す") return { ok: false, reason: FIX_NOT_READY } as const;
          const kind: AgentRunKind = "Action Item をやる（読むだけ）";
          const run = yield* requestRun(user, kind, openOf(task.value), { id: runId, taskId, request: item?.definition.title ?? "", actionItemId: itemId, subjectFingerprint: null }).pipe(Effect.result);
          if (run._tag === "Failure") return { ok: false, reason: run.failure.reason } as const;
          yield* agentRuns.save(run.success);
          yield* tasks.save({ ...task.value, plan: plan.success });
          return { ok: true, value: viewOf(run.success) } as const;
        });

      const autoStart = () =>
        Effect.gen(function* () {
          const policy = yield* currentPolicy;
          const read = AGENT_OPERATIONS.find((op) => op.tools === "読むだけ")!;
          const inRange = allowed(read.level, limitOf(policy, read.name), "外に書き込まない") === "自動でやる" ? "範囲に入る" : "範囲に入らない";
          const touched: string[] = [];
          for (const task of yield* tasks.listForBoard()) {
            if (task.status !== "やること" || task.plan === null) continue;
            let plan = task.plan;
            const created: AgentRun[] = [];
            for (const item of itemsOf(plan, { activeOnly: true })) {
              const how = item.definition.how;
              if (how.type !== "claude" || how.trigger !== "auto" || item.status !== "まだ" || turnOf(plan, item.id) !== "番が来ている") continue;
              // 直す作業は作業場所を用意できるまで自動でも始めない（fail closed）
              if (how.tools === "直す") continue;
              const runId = yield* ids.next;
              const next = yield* autoStartAgent(plan, item.id, app, { policy: inRange, task: "やること" }, runId).pipe(Effect.option);
              if (Option.isNone(next)) continue;
              const run = yield* requestRun(app, "Action Item をやる（読むだけ）", "開いている", { id: runId, taskId: task.id, request: item.definition.title, actionItemId: item.id, subjectFingerprint: null }).pipe(Effect.option);
              if (Option.isNone(run)) continue;
              plan = next.value;
              created.push(run.value);
            }
            if (created.length === 0) continue;
            for (const run of created) yield* agentRuns.save(run);
            yield* tasks.save({ ...task, plan });
            touched.push(task.id);
          }
          return touched;
        });

      /** 成果を Generation が Task の言葉にする。書けなければ、黙って変えずに「確かめる」を書く（fail closed） */
      const translate = (task: Task, outcome: AgentOutcome) =>
        Effect.gen(function* () {
          const generation = yield* ai.generation;
          if (Option.isNone(generation)) return { brief: UNSURE };
          const facts = yield* items.findMany(task.sourceItemIds);
          const written = yield* generation.value
            .write(rewriteTaskWriting, { task: taskMaterialOf(task, facts), arrival: { kind: "AI の作業の成果", fact: null, changedLines: [], agentOutcome: outcome } })
            .pipe(Effect.option);
          if (Option.isNone(written) || written.value.answer._tag === "Unanswered") return { brief: UNSURE };
          return { title: written.value.answer.value.title, brief: written.value.answer.value.brief };
        });

      const deliver = (run: AgentRun, outcome: AgentOutcome) =>
        Effect.gen(function* () {
          yield* note(run.taskId, "終わった", run);
          const task = yield* tasks.find(run.taskId);
          if (Option.isNone(task)) return;
          const change = yield* translate(task.value, outcome);
          const received = yield* receive(task.value, agent, "AI の作業の成果", change, `agent-result:${run.id}`).pipe(Effect.option);
          if (Option.isSome(received) && received.value !== task.value) yield* tasks.save(yield* prioritizer.refresh(received.value));
          yield* settleFinished(run.taskId);
          yield* changed(run.taskId);
        });

      const settleThread = (run: AgentRun, sessionId: string) =>
        Effect.gen(function* () {
          const found = yield* threads.find(run.taskId);
          const thread = Option.isNone(found)
            ? yield* openThread(app, { taskId: run.taskId, sessionId, workspace: `task:${run.taskId}` })
            : found.value.status === "続けられない"
              ? yield* renew(found.value, app, sessionId)
              : { ...found.value, sessionId };
          yield* threads.save(thread);
        }).pipe(Effect.orDie);

      const loseThread = (taskId: string) =>
        Effect.gen(function* () {
          const found = yield* threads.find(taskId);
          if (Option.isNone(found)) return;
          const lost = yield* lose(found.value, app, "動いている作業がない").pipe(Effect.option);
          if (Option.isSome(lost)) yield* threads.save(lost.value);
        });

      const current = (runId: string) => Effect.map(agentRuns.find(runId), Option.filter(isActiveRun));

      const handle = (runId: string, event: AgentEvent) =>
        Effect.gen(function* () {
          const found = yield* current(runId);
          // ユーザーが止めたあとに届いた出来事は捨てる
          if (Option.isNone(found)) return;
          const run = found.value;
          switch (event.type) {
            case "始まった":
              yield* settleThread(run, event.sessionId);
              yield* agentRuns.save({ ...run, sessionId: event.sessionId });
              return;
            case "進んだ":
              yield* agentRuns.save({ ...run, progress: [...run.progress, event.text.slice(0, PROGRESS_CHARS)].slice(-PROGRESS_LINES) });
              yield* changed(run.taskId);
              return;
            case "終わった": {
              const done = yield* Effect.orDie(succeedRun(run, agent, textOf(event.outcome)));
              yield* agentRuns.save(done);
              yield* deliver(done, event.outcome);
              return;
            }
            case "やめた": {
              const lost = event.reason === "作業場所が消えた" || event.reason === "続けられない会話";
              const stopped = yield* Effect.orDie(failRun(run, agent, event.reason === "作業場所が消えた" ? "作業場所が消えた" : "うまくいかなかった"));
              yield* agentRuns.save(stopped);
              if (lost) yield* loseThread(run.taskId);
              yield* note(run.taskId, "やめた", stopped);
            }
          }
        });

      /** 成果も、やめた知らせもなく流れが終わった・AI に届かなかったら、うまくいかなかったにする（黙って終わらせない） */
      const failIfStillActive = (runId: string) =>
        Effect.gen(function* () {
          const found = yield* current(runId);
          if (Option.isNone(found)) return;
          const stopped = yield* Effect.orDie(failRun(found.value, agent, "うまくいかなかった"));
          yield* agentRuns.save(stopped);
          yield* note(stopped.taskId, "やめた", stopped);
        });

      const runOne = (run: AgentRun) =>
        Effect.gen(function* () {
          const task = yield* tasks.find(run.taskId);
          if (Option.isNone(task)) return;
          const started = yield* startRun(run, app, { thread: "続けられる", task: openOf(task.value), others: "ほかに動いている作業はない" }).pipe(Effect.option);
          if (Option.isNone(started)) {
            const withdrawn = yield* withdrawRun(run, app, "やらなくなった").pipe(Effect.option);
            if (Option.isSome(withdrawn)) yield* agentRuns.save(withdrawn.value);
            return;
          }
          yield* agentRuns.save(started.value);
          yield* note(run.taskId, "始まった", started.value);
          const thread = yield* threads.find(run.taskId);
          const item = run.actionItemId === null || task.value.plan === null ? undefined : itemsOf(task.value.plan).find((entry) => entry.id === run.actionItemId);
          const request: AgentRunRequest = {
            runId: run.id,
            kind: run.kind,
            tools: run.tools,
            workspace: null,
            sessionId: Option.isSome(thread) && thread.value.status === "続けられる" ? thread.value.sessionId : null,
            task: taskMaterialOf(task.value, yield* items.findMany(task.value.sourceItemIds)),
            request: run.request,
            item: item === undefined ? null : { id: item.id, title: item.definition.title },
          };
          const consumer = yield* Effect.forkChild(
            Stream.runForEach(runner.run(request), (event) => handle(run.id, event)).pipe(
              Effect.catchTag("AiUnreachableError", () => Effect.void),
              Effect.andThen(failIfStillActive(run.id)),
            ),
          );
          consumers.set(run.id, consumer);
          yield* Fiber.await(consumer);
          consumers.delete(run.id);
        });

      const drainTask = (taskId: string): Effect.Effect<void, StoreCorrupted, DocumentStore> =>
        Effect.gen(function* () {
          while (true) {
            // AI 設定が使えないあいだは待ち行列のまま置く（設定していない AI に Task の中身を渡さない）
            if (!(yield* ai.active)) return;
            const all = yield* agentRuns.all();
            if (all.some((run) => run.taskId === taskId && isActiveRun(run))) return;
            const next = all.filter((run) => run.taskId === taskId && run.status === "待ち行列").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
            if (next === undefined) return;
            yield* runOne(next);
          }
        });

      const pump = () =>
        Effect.gen(function* () {
          const all = yield* agentRuns.all();
          const waiting = [...new Set(all.filter((run) => run.status === "待ち行列").map((run) => run.taskId))];
          const fibers: Array<Fiber.Fiber<void, never>> = [];
          for (const taskId of waiting) {
            if (draining.has(taskId) || all.some((run) => run.taskId === taskId && isActiveRun(run))) continue;
            draining.add(taskId);
            fibers.push(
              yield* Effect.forkDetach(
                drainTask(taskId).pipe(
                  Effect.provideService(DocumentStore, docs),
                  Effect.catchCause(() => Effect.void),
                  Effect.ensuring(Effect.sync(() => draining.delete(taskId))),
                ),
              ),
            );
          }
          return fibers;
        });

      const stop = (runId: string) =>
        Effect.gen(function* () {
          const found = yield* agentRuns.find(runId);
          if (Option.isNone(found)) return { ok: false, reason: "作業が見つかりません" } as const;
          const stopped = yield* stopRun(found.value, user).pipe(Effect.result);
          if (stopped._tag === "Failure") return { ok: false, reason: stopped.failure.reason } as const;
          // 先に止まったを保存してから Claude Code を止める（止める途中に届いた出来事で、作業が進まないように）
          yield* agentRuns.save(stopped.success);
          const consumer = consumers.get(runId);
          if (consumer !== undefined) yield* Fiber.interrupt(consumer);
          yield* note(stopped.success.taskId, "やめた", stopped.success);
          return { ok: true, value: null } as const;
        });

      const cancel = (runId: string) =>
        Effect.gen(function* () {
          const found = yield* agentRuns.find(runId);
          if (Option.isNone(found)) return { ok: false, reason: "作業が見つかりません" } as const;
          const cancelled = yield* cancelRun(found.value, user, "ユーザーが取り消した").pipe(Effect.result);
          if (cancelled._tag === "Failure") return { ok: false, reason: cancelled.failure.reason } as const;
          yield* agentRuns.save(cancelled.success);
          return { ok: true, value: null } as const;
        });

      const withdrawOne = (run: AgentRun, reason: "やらなくなった" | "ユーザーが済ませた") =>
        Effect.gen(function* () {
          const withdrawn = yield* withdrawRun(run, app, reason).pipe(Effect.option);
          if (Option.isNone(withdrawn)) return;
          yield* agentRuns.save(withdrawn.value);
          const consumer = consumers.get(run.id);
          if (consumer !== undefined) yield* Fiber.interrupt(consumer);
          if (isActiveRun(run)) yield* note(run.taskId, "やめた", withdrawn.value);
        });

      const settleFinished = (taskId: string): Effect.Effect<void, StoreCorrupted, DocumentStore> =>
        Effect.gen(function* () {
          const found = yield* tasks.find(taskId);
          if (Option.isNone(found)) return;
          const runs = (yield* agentRuns.all()).filter((run) => run.taskId === taskId);
          const plan = found.value.plan;
          // Action Item ごとの理由を先に残す（済ませた Action Item で Task も終わったときに、やらなくなったと記録しないように）
          for (const item of plan === null ? [] : itemsOf(plan)) {
            const run = runs.find((entry) => entry.id === agentRunOf(plan!, item.id));
            if (run !== undefined && item.status !== "まだ" && isOpenRun(run)) yield* withdrawOne(run, item.status === "済んだ" ? "ユーザーが済ませた" : "やらなくなった");
          }
          if (found.value.status !== "やること") {
            for (const run of (yield* agentRuns.all()).filter((entry) => entry.taskId === taskId && isOpenRun(entry))) yield* withdrawOne(run, "やらなくなった");
            return;
          }
          if (plan === null) return;
          for (const item of itemsOf(plan)) {
            const run = runs.find((entry) => entry.id === agentRunOf(plan, item.id));
            if (run === undefined || item.status !== "まだ" || run.status !== "終わった") continue;
            const next = yield* succeedByAgent(plan, item.id, app, { run: "やり遂げた", subject: "頼んだときのまま" }).pipe(Effect.option);
            if (Option.isNone(next)) continue;
            yield* planner.progressed(found.value, next.value, app, item.id);
            // 果たしたら計画が変わるので、次の Action Item は読み直してから見る
            return yield* settleFinished(taskId);
          }
        });

      const recover = () =>
        Effect.gen(function* () {
          for (const run of (yield* agentRuns.all()).filter(isActiveRun)) {
            const stopped = yield* Effect.orDie(failRun(run, app, "アプリを閉じた"));
            yield* agentRuns.save(stopped);
            yield* note(run.taskId, "やめた", stopped);
          }
        });

      const runsOf = (taskId: string) => Effect.map(agentRuns.all(), (all) => runsOfTask(all, taskId));

      const scoped = <A, E>(effect: Effect.Effect<A, E, DocumentStore>) => effect.pipe(Effect.provideService(DocumentStore, docs));
      return AgentService.of({
        ask: (taskId, request) => scoped(ask(taskId, request)),
        requestFromItem: (taskId, itemId) => scoped(requestFromItem(taskId, itemId)),
        stop: (runId) => scoped(stop(runId)),
        cancel: (runId) => scoped(cancel(runId)),
        runsOf: (taskId) => scoped(runsOf(taskId)),
        autoStart: () => scoped(autoStart()),
        settleFinished: (taskId) => scoped(settleFinished(taskId)),
        pump: () => scoped(pump()),
        recover: () => scoped(recover()),
        onChanged: (listener) => Effect.sync(() => void listeners.push(listener)),
      });
    }),
  );
}
