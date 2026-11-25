import { and, desc, eq, inArray } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
import { ClaudeCode } from "../core/agent/claude-code.js";
import {
  CONFLICT_RESOLUTION_JSON_SCHEMA,
  CONFLICT_RESOLUTION_TOOLS,
  type ConflictResolution,
  conflictResolutionPrompt,
  decodeConflictResolution,
} from "../core/agent/conflict-resolution.js";
import { ConflictWorkspace } from "../core/agent/conflict-workspace.js";
import { Database } from "../core/db/database.js";
import { agentRuns, approvals, sourceItems, taskLinks } from "../core/db/schema.js";
import { completeStep, currentSteps, decodePlan } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import type { TaskStatus } from "../core/task/task.js";

export class ConflictResolutionError extends Schema.TaggedError<ConflictResolutionError>()("ConflictResolutionError", {
  message: Schema.String,
}) {}

export const CONFLICT_KIND = "resolve_conflicts";
const PUSH_ACTION = "push_conflict_resolution";
const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/;
const SOURCE = /^github:([a-z0-9][a-z0-9-]*)(?::watch)?$/;

export type ConflictRunResult = ConflictResolution & {
  repository: string;
  headRef: string;
  baseRef: string;
  conflicted: ReadonlyArray<string>;
  commitSha: string;
  diff: string;
  cwd: string;
};

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (message: string) => new ConflictResolutionError({ message });
const messageOf = (error: unknown) => (typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error));

/** Task が追う PR と、そのアカウント */
const trackedPull = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const items = yield* db
    .select({ url: sourceItems.url, source: sourceItems.source })
    .from(taskLinks)
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.role, "tracks")))
    .pipe(Effect.orDie);
  for (const item of items) {
    const pull = PULL_URL.exec(item.url);
    const account = SOURCE.exec(item.source);
    if (pull !== null && account !== null) return { url: item.url, repository: pull[1]!, number: Number(pull[2]), accountId: account[1]! };
  }
  return yield* failure("GitHub の PR を追う Task ではない");
});

export const conflictTarget = trackedPull;

const moveTask = Effect.fnUntraced(function* (taskId: number, to: TaskStatus, actor: "user" | "agent") {
  const tasks = yield* TaskRepository;
  const task = Option.getOrThrow(yield* tasks.findTask(taskId));
  if (task.status === to) return;
  yield* tasks.updateTask(taskId, { status: to });
  yield* tasks.recordChange(taskId, { kind: "field_changed", field: "status", before: task.status, after: to, unread: false, actor });
});

const completeCurrent = Effect.fnUntraced(function* (taskId: number, kind: "resolve_conflicts" | "push_conflict_resolution") {
  const tasks = yield* TaskRepository;
  const task = Option.getOrThrow(yield* tasks.findTask(taskId));
  const plan = decodePlan(task.nextActions);
  if (Option.isNone(plan)) return;
  const step = currentSteps(plan.value).find((candidate) => candidate.kind === kind);
  if (step !== undefined) yield* tasks.updateTask(taskId, { nextActions: completeStep(plan.value, step.id) });
});

/** コンフリクトを直し始める。Task を処理中のレーンに移し、直すのは finishConflictResolution で裏で行う */
export const startConflictResolution = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const tasks = yield* TaskRepository;
  yield* trackedPull(taskId);
  const running = yield* db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), inArray(agentRuns.status, ["queued", "running"])))
    .pipe(Effect.orDie);
  if (running.length > 0) return yield* failure("この Task は、ほかの処理か、コンフリクトを直している最中");
  const task = Option.getOrThrow(yield* tasks.findTask(taskId));
  const [run] = yield* db
    .insert(agentRuns)
    .values({ taskId, kind: CONFLICT_KIND, status: "running", subjectFingerprint: "", previousStatus: task.status, startedAt: yield* nowIso })
    .returning({ id: agentRuns.id })
    .pipe(Effect.orDie);
  yield* moveTask(taskId, "agent_running", "user");
  return run!.id;
});

const resolve = Effect.fnUntraced(function* (runId: number, options: { model?: string; maxBudgetUsd?: number }) {
  const db = yield* Database;
  const claude = yield* ClaudeCode;
  const workspace = yield* ConflictWorkspace;
  const [run] = yield* db.select().from(agentRuns).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
  if (run === undefined) return yield* failure("記録が見つからない");
  const pull = yield* trackedPull(run.taskId);
  const prepared = yield* workspace.prepare(run.taskId, pull.url);

  let resolution: ConflictResolution = { summary: "コンフリクトはなかった（ベースのブランチをそのまま取り込める）", files: [], concerns: "" };
  let sessionId: string | null = null;
  let costUsd: number | undefined;
  if (prepared.conflicted.length > 0) {
    const result = yield* claude.run({
      prompt: conflictResolutionPrompt(prepared),
      cwd: prepared.cwd,
      jsonSchema: CONFLICT_RESOLUTION_JSON_SCHEMA,
      allowedTools: CONFLICT_RESOLUTION_TOOLS,
      model: options.model,
      maxBudgetUsd: options.maxBudgetUsd,
    });
    resolution = yield* decodeConflictResolution(result.structured).pipe(Effect.mapError(() => failure("AI の回答の形が違う")));
    sessionId = result.sessionId;
    costUsd = result.costUsd;
  }
  const committed = yield* workspace.commit(prepared.cwd, prepared.conflicted);
  const stored: ConflictRunResult = {
    ...resolution,
    repository: prepared.repository,
    headRef: prepared.headRef,
    baseRef: prepared.baseRef,
    conflicted: prepared.conflicted,
    commitSha: committed.commitSha,
    diff: committed.diff,
    cwd: prepared.cwd,
  };
  return { run, stored, headSha: prepared.headSha, sessionId, costUsd };
});

/** 裏でコンフリクトを直す。結果（成功・失敗）は Task と記録に残すので、失敗は返さない */
export const finishConflictResolution = (runId: number, options: { model?: string; maxBudgetUsd?: number }) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const tasks = yield* TaskRepository;
    const [run] = yield* db.select().from(agentRuns).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
    if (run === undefined) return;
    const outcome = yield* resolve(runId, options).pipe(Effect.result);
    const finishedAt = yield* nowIso;
    if (outcome._tag === "Failure") {
      const message = messageOf(outcome.failure);
      yield* db.update(agentRuns).set({ status: "failed", error: message, finishedAt }).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
      yield* moveTask(run.taskId, run.previousStatus as TaskStatus, "agent");
      yield* tasks.recordChange(run.taskId, { kind: "field_changed", field: "conflict", before: null, after: `コンフリクトを直せなかった: ${message}`, unread: true, actor: "agent" });
      return;
    }
    const { stored, headSha, sessionId, costUsd } = outcome.success;
    yield* db
      .update(agentRuns)
      .set({ status: "succeeded", result: stored, subjectSha: headSha, sessionId, costUsd: costUsd?.toString() ?? null, finishedAt })
      .where(eq(agentRuns.id, runId))
      .pipe(Effect.orDie);
    yield* completeCurrent(run.taskId, "resolve_conflicts");
    yield* moveTask(run.taskId, run.previousStatus as TaskStatus, "agent");
    yield* tasks.recordChange(run.taskId, { kind: "field_changed", field: "conflict", before: null, after: `コンフリクトを直した: ${stored.summary}`, unread: true, actor: "agent" });
  });

/** 最後に直した記録。push の確認に出す */
export const latestConflictResolution = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const [run] = yield* db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.kind, CONFLICT_KIND), eq(agentRuns.status, "succeeded")))
    .orderBy(desc(agentRuns.id))
    .limit(1)
    .pipe(Effect.orDie);
  if (run === undefined || run.subjectSha === null) return Option.none<{ runId: number; headSha: string; result: ConflictRunResult }>();
  return Option.some({ runId: run.id, headSha: run.subjectSha, result: run.result as ConflictRunResult });
});

/**
 * 外部への書き込み。ユーザーが差分を確かめて承認したあとにだけ呼ぶ。承認を記録してから、
 * 直し始めたときの head から PR のブランチが動いていないことを確かめて push する
 */
export const pushConflictResolution = Effect.fnUntraced(function* <E, R>(taskId: number, tokenFor: (accountId: string) => Effect.Effect<string, E, R>) {
  const db = yield* Database;
  const tasks = yield* TaskRepository;
  const workspace = yield* ConflictWorkspace;
  const latest = yield* latestConflictResolution(taskId);
  if (Option.isNone(latest)) return yield* failure("コンフリクトを直した記録がない");
  const pull = yield* trackedPull(taskId);
  const { runId, headSha, result } = latest.value;
  const token = yield* tokenFor(pull.accountId);
  const record = {
    taskId,
    action: PUSH_ACTION,
    target: `${pull.repository}#${pull.number}`,
    payload: { runId, headRef: result.headRef, commitSha: result.commitSha, baseSha: headSha },
    approvedAt: yield* nowIso,
  };
  const pushed = yield* workspace.push(result.cwd, result.headRef, headSha, token).pipe(Effect.result);
  const executedAt = yield* nowIso;
  if (pushed._tag === "Failure") {
    yield* db.insert(approvals).values({ ...record, status: "failed", error: pushed.failure.message, executedAt }).pipe(Effect.orDie);
    return yield* failure(pushed.failure.message);
  }
  yield* db.insert(approvals).values({ ...record, status: "executed", executedAt }).pipe(Effect.orDie);
  yield* completeCurrent(taskId, "push_conflict_resolution");
  yield* tasks.recordChange(taskId, { kind: "field_changed", field: "conflict", before: null, after: `直した内容を ${result.headRef} に push した`, unread: false, actor: "user" });
});
