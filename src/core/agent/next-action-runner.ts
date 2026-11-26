import { and, eq, inArray, isNull } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
import { Database } from "../db/database.js";
import { agentRuns, sourceItems, taskLinks, tasks } from "../db/schema.js";
import { TaskRepository } from "../task/task-repository.js";
import { decodePlan, doneHistory } from "../task/next-actions.js";
import type { TaskStatus } from "../task/task.js";
import { AgentWorkspace } from "./agent-workspace.js";
import { ClaudeCode } from "./claude-code.js";
import { isDependencyBot } from "./dependency-review.js";
import { moveTask, RETRY_FAILED_AFTER_MILLIS } from "./dependency-triage.js";
import { NEXT_ACTION_PLAN_JSON_SCHEMA, decodeProposedPlan, nextActionPrompt, planFromProposal } from "./next-action-planning.js";

const KIND = "next_actions";

export class ReplanError extends Schema.TaggedError<ReplanError>()("ReplanError", { message: Schema.String }) {}

/** 次にやることを考え直す。済んだ手順は残し、残りだけを AI に考えさせる（調査待ちに入れ、次の定期の処理で考える） */
export const requestReplan = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const taskRepository = yield* TaskRepository;
  const task = yield* taskRepository.findTask(taskId);
  if (Option.isNone(task)) return yield* new ReplanError({ message: "Task が見つからない" });
  if (task.value.status === "agent_running") return yield* new ReplanError({ message: "処理中の Task は考え直せない。終わってからにしてください" });
  yield* db
    .insert(agentRuns)
    .values({
      taskId,
      kind: KIND,
      status: "queued",
      subjectFingerprint: "",
      previousStatus: task.value.status,
      result: { replanFrom: task.value.nextActions },
      startedAt: yield* nowIso,
    })
    .pipe(Effect.orDie);
  yield* moveTask(taskId, task.value.status, "agent_running");
});

const ReplanRequest = Schema.Struct({ replanFrom: Schema.Unknown });
const historyOf = (result: unknown) =>
  Option.match(
    Option.flatMap(Schema.decodeUnknownOption(ReplanRequest)(result), (request) => decodePlan(request.replanFrom)),
    { onNone: () => undefined, onSome: doneHistory },
  );
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
    // 考え直しなら、済んだ手順を残して AI に伝える
    const history = historyOf(run.result);
    const context = {
      ...(history === undefined ? {} : { doneSteps: history.map((step) => step.title) }),
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
      const pull = items.find((item) => item.role === "tracks" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(item.url));
      const prState =
        pull === undefined ? undefined : yield* workspace.pullRequestState(pull.url).pipe(Effect.orElseSucceed(() => "（取得できなかった）"));
      // リポジトリの手順（deploy など）を読ませるため。用意できなくても、集めた情報だけで考えさせる
      const repository = pull === undefined ? undefined : /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pull.url)?.[1];
      const prepared =
        pull === undefined || repository === undefined
          ? undefined
          : Option.getOrUndefined(yield* workspace.prepare(repository, run.taskId, pull.url).pipe(Effect.option));
      const contextDir = yield* workspace.writeContext(run.taskId, {
        "task.json": JSON.stringify(context, null, 2),
        ...(prState === undefined ? {} : { "pr-state.json": prState }),
      });
      const result = yield* claude.run({
        prompt: nextActionPrompt({ title: task.value.title, contextDir, repository: prepared?.cwd, replanning: history !== undefined }),
        cwd: prepared?.cwd ?? contextDir,
        ...(prepared === undefined ? {} : { addDirs: [contextDir] }),
        jsonSchema: NEXT_ACTION_PLAN_JSON_SCHEMA,
        allowedTools: PLANNING_TOOLS,
        model: options.model,
        maxBudgetUsd: options.maxBudgetUsd,
      });
      const proposal = yield* decodeProposedPlan(result.structured).pipe(
        Effect.mapError((error) => ({ message: `claude の回答の形が想定と違う: ${error.message}` })),
      );
      const proposed = planFromProposal(proposal, yield* nowIso);
      const { suggest, ...suggestion } = proposal.recurring;
      return { result, plan: { steps: [...(history ?? []), ...proposed.steps] }, recurringSuggestion: suggest ? suggestion : null };
    }).pipe(Effect.result);

    const finishedAt = yield* nowIso;
    if (outcome._tag === "Failure") {
      yield* db.update(agentRuns).set({ status: "failed", error: outcome.failure.message, finishedAt }).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
      yield* Effect.logWarning("次にやることを考えられなかった").pipe(Effect.annotateLogs({ taskId: run.taskId, reason: outcome.failure.message }));
      yield* moveTask(run.taskId, "agent_running", previousStatus);
      return Option.some({ taskId: run.taskId, succeeded: false });
    }

    const { result, plan, recurringSuggestion } = outcome.success;
    yield* db
      .update(agentRuns)
      .set({ status: "succeeded", result: plan, sessionId: result.sessionId, costUsd: result.costUsd?.toString() ?? null, finishedAt })
      .where(eq(agentRuns.id, runId))
      .pipe(Effect.orDie);
    yield* taskRepository.updateTask(run.taskId, { nextActions: plan, recurringSuggestion });
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
