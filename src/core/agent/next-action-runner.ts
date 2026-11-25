import { and, eq, inArray, isNull } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
import { Database } from "../db/database.js";
import { agentRuns, sourceItems, taskLinks, tasks } from "../db/schema.js";
import { TaskRepository } from "../task/task-repository.js";
import type { TaskStatus } from "../task/task.js";
import { AgentWorkspace } from "./agent-workspace.js";
import { ClaudeCode } from "./claude-code.js";
import { isDependencyBot } from "./dependency-review.js";
import { moveTask, RETRY_FAILED_AFTER_MILLIS } from "./dependency-triage.js";
import { NEXT_ACTION_PLAN_JSON_SCHEMA, decodeProposedPlan, nextActionPrompt, planFromProposal } from "./next-action-planning.js";

const KIND = "next_actions";
// 進行中も含める理由: すべての Task に次にやることを入れるため
const ELIGIBLE_STATUSES: ReadonlyArray<TaskStatus> = ["needs_review", "todo", "in_progress"];
// 集めた情報だけを読ませる。リポジトリは渡さないので、Bash や WebFetch は要らない
const PLANNING_TOOLS: ReadonlyArray<string> = ["Read", "Grep", "Glob"];

export type NextActionPlanningOptions = { sources: ReadonlyArray<string>; model?: string; maxBudgetUsd?: number; concurrency: number };

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const StoredJudgment = Schema.Struct({ request: Schema.Struct({ input: Schema.String }) });
const decodeJudgment = Schema.decodeUnknownOption(StoredJudgment);
/** 通知を判定したときに集めた内容（本文の抜粋など） */
const collectedOf = (judgment: unknown) => Option.getOrUndefined(Option.map(decodeJudgment(judgment), (decoded) => decoded.request.input));

/**
 * 次にやることがない Task を調査待ちにしてレーンに入れ、claude に次にやることを考えさせる。
 * 依存更新の bot の PR は、依存更新の調査で次にやることを作るので対象にしない。
 */
export const runNextActionPlanning = (options: NextActionPlanningOptions) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db
      .select({ taskId: tasks.id, status: tasks.status, source: sourceItems.source, author: sourceItems.author, url: sourceItems.url })
      .from(taskLinks)
      .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(and(eq(taskLinks.role, "tracks"), isNull(tasks.nextActions), inArray(tasks.status, [...ELIGIBLE_STATUSES])))
      .orderBy(tasks.id)
      .pipe(Effect.orDie);

    const byTask = new Map<number, { status: TaskStatus; eligible: boolean }>();
    for (const row of rows) {
      const entry = byTask.get(row.taskId) ?? { status: row.status, eligible: true };
      const dependencyPull = row.url.includes("/pull/") && isDependencyBot(row.author);
      if (!options.sources.includes(row.source) || dependencyPull) entry.eligible = false;
      byTask.set(row.taskId, entry);
    }

    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const [taskId, entry] of byTask) {
      if (!entry.eligible) continue;
      const previous = yield* db.select().from(agentRuns).where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.kind, KIND))).pipe(Effect.orDie);
      const blocked = previous.some(
        (run) => run.status !== "failed" || run.finishedAt === null || now - Date.parse(run.finishedAt) < RETRY_FAILED_AFTER_MILLIS,
      );
      if (blocked) continue;
      yield* db
        .insert(agentRuns)
        .values({ taskId, kind: KIND, status: "queued", subjectFingerprint: "", previousStatus: entry.status, startedAt: yield* nowIso })
        .pipe(Effect.orDie);
      yield* moveTask(taskId, entry.status, "agent_running");
    }

    const queued = yield* db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.kind, KIND), eq(agentRuns.status, "queued")))
      .orderBy(agentRuns.id)
      .pipe(Effect.orDie);
    const outcomes = yield* Effect.forEach(queued, (run) => planQueued(run.id, options), { concurrency: options.concurrency });
    return outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []));
  });

const planQueued = (runId: number, options: NextActionPlanningOptions) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const taskRepository = yield* TaskRepository;
    const claude = yield* ClaudeCode;
    const workspace = yield* AgentWorkspace;

    const [run] = yield* db.select().from(agentRuns).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
    if (run === undefined || run.status !== "queued") return Option.none<{ taskId: number; succeeded: boolean }>();
    const task = yield* taskRepository.findTask(run.taskId);
    if (Option.isNone(task) || task.value.status !== "agent_running") {
      yield* db.delete(agentRuns).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
      return Option.none<{ taskId: number; succeeded: boolean }>();
    }
    const previousStatus = run.previousStatus as TaskStatus;
    yield* db.update(agentRuns).set({ status: "running", startedAt: yield* nowIso }).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);

    const items = yield* db
      .select({ role: taskLinks.role, source: sourceItems.source, title: sourceItems.title, url: sourceItems.url, state: sourceItems.state, judgment: sourceItems.judgment })
      .from(taskLinks)
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(eq(taskLinks.taskId, run.taskId))
      .pipe(Effect.orDie);
    const context = {
      title: task.value.title,
      brief: task.value.brief,
      items: items.map((item) => ({
        role: item.role,
        source: item.source,
        title: item.title,
        url: item.url,
        state: item.state,
        collected: collectedOf(item.judgment),
      })),
    };

    const outcome = yield* Effect.gen(function* () {
      const contextDir = yield* workspace.writeContext(run.taskId, { "task.json": JSON.stringify(context, null, 2) });
      const result = yield* claude.run({
        prompt: nextActionPrompt({ title: task.value.title, contextDir }),
        cwd: contextDir,
        jsonSchema: NEXT_ACTION_PLAN_JSON_SCHEMA,
        allowedTools: PLANNING_TOOLS,
        model: options.model,
        maxBudgetUsd: options.maxBudgetUsd,
      });
      const proposal = yield* decodeProposedPlan(result.structured).pipe(
        Effect.mapError((error) => ({ message: `claude の回答の形が想定と違う: ${error.message}` })),
      );
      return { result, plan: planFromProposal(proposal) };
    }).pipe(Effect.result);

    const finishedAt = yield* nowIso;
    if (outcome._tag === "Failure") {
      yield* db.update(agentRuns).set({ status: "failed", error: outcome.failure.message, finishedAt }).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
      yield* Effect.logWarning("次にやることを考えられなかった").pipe(Effect.annotateLogs({ taskId: run.taskId, reason: outcome.failure.message }));
      yield* moveTask(run.taskId, "agent_running", previousStatus);
      return Option.some({ taskId: run.taskId, succeeded: false });
    }

    const { result, plan } = outcome.success;
    yield* db
      .update(agentRuns)
      .set({ status: "succeeded", result: plan, sessionId: result.sessionId, costUsd: result.costUsd?.toString() ?? null, finishedAt })
      .where(eq(agentRuns.id, runId))
      .pipe(Effect.orDie);
    yield* taskRepository.updateTask(run.taskId, { nextActions: plan });
    yield* taskRepository.recordChange(run.taskId, {
      kind: "field_changed",
      field: "next_actions",
      before: null,
      after: plan.steps.map((step) => step.title).join(" / "),
      unread: true,
      actor: "agent",
    });
    yield* moveTask(run.taskId, "agent_running", previousStatus);
    return Option.some({ taskId: run.taskId, succeeded: true });
  });
