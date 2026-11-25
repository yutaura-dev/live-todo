import { and, desc, eq, inArray } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";
import { Database } from "../db/database.js";
import { agentRuns, agentThreads, sourceItems, taskLinks, tasks } from "../db/schema.js";
import { TaskRepository } from "../task/task-repository.js";
import type { TaskStatus } from "../task/task.js";
import { ClaudeCode } from "./claude-code.js";
import { AgentWorkspace } from "./agent-workspace.js";
import {
  DEPENDENCY_REVIEW_JSON_SCHEMA,
  DEPENDENCY_REVIEW_TOOLS,
  type DependencyReview,
  decodeDependencyReview,
  dependencyReviewPrompt,
  isDependencyBot,
} from "./dependency-review.js";

const KIND = "dependency_review";
const PROVIDER = "claude-code";
// 自分で手を付けた（進行中）ものや終わったものには割り込まない
const ELIGIBLE_STATUSES: ReadonlyArray<TaskStatus> = ["needs_review", "todo"];
const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+/;

const CONCLUSION_TEXT: Record<DependencyReview["conclusion"], string> = {
  mergeable: "merge 可能",
  mergeable_after_fix: "修正すれば merge 可能",
  not_mergeable: "merge できない",
};

export const briefOf = (review: DependencyReview) => `依存更新の調査: ${CONCLUSION_TEXT[review.conclusion]}`;

export type DependencyReviewOptions = { sources: ReadonlyArray<string>; model?: string; maxBudgetUsd?: number };

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * 依存更新の bot の PR を追う Task を 1 件選んで調べる。対象がなければ none。
 * 同じ状態の PR は二度調べない（失敗したものも、PR が更新されるまでやり直さない）。
 */
export const runNextDependencyReview = (options: DependencyReviewOptions) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const taskRepository = yield* TaskRepository;
    const claude = yield* ClaudeCode;
    const workspace = yield* AgentWorkspace;

    const rows = yield* db
      .select({
        taskId: tasks.id,
        status: tasks.status,
        title: sourceItems.title,
        url: sourceItems.url,
        author: sourceItems.author,
        fingerprint: sourceItems.fingerprint,
      })
      .from(taskLinks)
      .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(
        and(
          eq(taskLinks.role, "tracks"),
          eq(sourceItems.state, "open"),
          inArray(sourceItems.source, [...options.sources]),
          inArray(tasks.status, [...ELIGIBLE_STATUSES]),
        ),
      )
      .orderBy(tasks.id)
      .pipe(Effect.orDie);

    let candidate: (typeof rows)[number] & { repository: string } | undefined;
    for (const row of rows) {
      const pull = PULL_URL.exec(row.url);
      if (pull === null || !isDependencyBot(row.author)) continue;
      const reviewed = yield* db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.taskId, row.taskId), eq(agentRuns.kind, KIND), eq(agentRuns.subjectFingerprint, row.fingerprint)))
        .limit(1)
        .pipe(Effect.orDie);
      if (reviewed.length === 0) {
        candidate = { ...row, repository: pull[1]! };
        break;
      }
    }
    if (candidate === undefined) return Option.none<{ taskId: number; succeeded: boolean }>();
    const target = candidate;

    const [run] = yield* db
      .insert(agentRuns)
      .values({
        taskId: target.taskId,
        kind: KIND,
        status: "running",
        subjectFingerprint: target.fingerprint,
        previousStatus: target.status,
        startedAt: yield* nowIso,
      })
      .returning({ id: agentRuns.id })
      .pipe(Effect.orDie);
    const runId = run!.id;
    yield* moveTask(target.taskId, target.status, "agent_running");

    const outcome = yield* Effect.gen(function* () {
      const { cwd, contextDir } = yield* workspace.prepare(target.repository, target.taskId, target.url);
      const [thread] = yield* db.select().from(agentThreads).where(eq(agentThreads.taskId, target.taskId)).pipe(Effect.orDie);
      const result = yield* claude.run({
        prompt: dependencyReviewPrompt({ url: target.url, repository: target.repository, title: target.title, contextDir }),
        cwd,
        addDirs: [contextDir],
        // session は作業ディレクトリに結び付くので、同じ場所のときだけ続ける
        resumeSessionId: thread !== undefined && thread.workspace === cwd ? thread.sessionId : undefined,
        jsonSchema: DEPENDENCY_REVIEW_JSON_SCHEMA,
        allowedTools: DEPENDENCY_REVIEW_TOOLS,
        model: options.model,
        maxBudgetUsd: options.maxBudgetUsd,
      });
      const review = yield* decodeDependencyReview(result.structured).pipe(
        Effect.mapError((error) => ({ message: `claude の回答の形が想定と違う: ${error.message}` })),
      );
      return { cwd, result, review };
    }).pipe(Effect.result);

    const finishedAt = yield* nowIso;
    if (outcome._tag === "Success") {
      const { cwd, result, review } = outcome.success;
      yield* db
        .update(agentRuns)
        .set({ status: "succeeded", result: review, sessionId: result.sessionId, costUsd: result.costUsd?.toString() ?? null, finishedAt })
        .where(eq(agentRuns.id, runId))
        .pipe(Effect.orDie);
      yield* db
        .insert(agentThreads)
        .values({ taskId: target.taskId, provider: PROVIDER, sessionId: result.sessionId, workspace: cwd, updatedAt: finishedAt })
        .onConflictDoUpdate({ target: agentThreads.taskId, set: { sessionId: result.sessionId, workspace: cwd, updatedAt: finishedAt } })
        .pipe(Effect.orDie);
      const task = Option.getOrThrow(yield* taskRepository.findTask(target.taskId));
      const brief = briefOf(review);
      yield* taskRepository.updateTask(target.taskId, { brief });
      // 結論が出たことを更新マークで知らせる
      yield* taskRepository.recordChange(target.taskId, { kind: "field_changed", field: "brief", before: task.brief, after: brief, unread: true, actor: "agent" });
      yield* moveTask(target.taskId, "agent_running", "todo");
      return Option.some({ taskId: target.taskId, succeeded: true });
    }

    yield* db.update(agentRuns).set({ status: "failed", error: outcome.failure.message, finishedAt }).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
    yield* Effect.logWarning("依存更新の PR を調べられなかった").pipe(Effect.annotateLogs({ taskId: target.taskId, reason: outcome.failure.message }));
    yield* moveTask(target.taskId, "agent_running", target.status);
    return Option.some({ taskId: target.taskId, succeeded: false });
  });

/** 状態を変える。ただし、調べている間に同期などが状態を変えていたら（merge されて完了など）上書きしない */
const moveTask = (taskId: number, expected: TaskStatus, next: TaskStatus) =>
  Effect.gen(function* () {
    const taskRepository = yield* TaskRepository;
    const current = Option.getOrThrow(yield* taskRepository.findTask(taskId)).status;
    if (current !== expected || current === next) return;
    yield* taskRepository.updateTask(taskId, { status: next });
    yield* taskRepository.recordChange(taskId, { kind: "field_changed", field: "status", before: current, after: next, unread: false, actor: "agent" });
  });

/** アプリが途中で終わり、調査中のまま残ったものを失敗として閉じ、Task を元のレーンに戻す */
export const recoverInterruptedAgentRuns = Effect.gen(function* () {
  const db = yield* Database;
  const running = yield* db.select().from(agentRuns).where(eq(agentRuns.status, "running")).orderBy(desc(agentRuns.id)).pipe(Effect.orDie);
  const finishedAt = yield* nowIso;
  for (const run of running) {
    yield* db.update(agentRuns).set({ status: "failed", error: "アプリが途中で終了した", finishedAt }).where(eq(agentRuns.id, run.id)).pipe(Effect.orDie);
    yield* moveTask(run.taskId, "agent_running", run.previousStatus as TaskStatus);
  }
  return running.length;
});
