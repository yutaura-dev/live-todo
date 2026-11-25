import { and, eq, inArray } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
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

export type DependencyReviewOptions = {
  sources: ReadonlyArray<string>;
  model?: string;
  maxBudgetUsd?: number;
  /** 同時に調べる数の上限。Claude Code は並列に動かせるが、増やしすぎると使用量の枠をすぐに使い切る */
  concurrency: number;
};

export type DependencyReviewOutcome = { taskId: number; succeeded: boolean };

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * 依存更新の bot の PR を追う Task を、すべて調査待ちとしてレーンに入れ、待ちを同時に concurrency 件まで調べ切る。
 * 同じ状態の PR は二度調べない（失敗したものも、PR が更新されるまでやり直さない）。
 */
export const runDependencyReviews = (options: DependencyReviewOptions) =>
  Effect.gen(function* () {
    const db = yield* Database;

    const rows = yield* db
      .select({
        taskId: tasks.id,
        status: tasks.status,
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

    // 見つけた対象はすべて調査待ちにしてレーンに入れる（順番を待っていることを画面で見えるようにするため）
    for (const row of rows) {
      if (PULL_URL.exec(row.url) === null || !isDependencyBot(row.author)) continue;
      const reviewed = yield* db
        .select({ status: agentRuns.status, subjectSha: agentRuns.subjectSha })
        .from(agentRuns)
        .where(and(eq(agentRuns.taskId, row.taskId), eq(agentRuns.kind, KIND), eq(agentRuns.subjectFingerprint, row.fingerprint)))
        .pipe(Effect.orDie);
      // 成功したのに commit が残っていない調査は、commit を残す前のもの。merge に使えないので調べ直す
      if (reviewed.some((run) => !(run.status === "succeeded" && run.subjectSha === null))) continue;
      yield* db
        .insert(agentRuns)
        .values({ taskId: row.taskId, kind: KIND, status: "queued", subjectFingerprint: row.fingerprint, previousStatus: row.status, startedAt: yield* nowIso })
        .pipe(Effect.orDie);
      yield* moveTask(row.taskId, row.status, "agent_running");
    }

    const queued = yield* db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.kind, KIND), eq(agentRuns.status, "queued")))
      .orderBy(agentRuns.id)
      .pipe(Effect.orDie);
    const outcomes = yield* Effect.forEach(queued, (run) => reviewQueued(run.id, options), { concurrency: options.concurrency });
    return outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []));
  });

/** 調査待ちを 1 件調べる。待っている間に同期などが状態を変えたもの（merge されて完了など）は調べずに待ちから外す */
const reviewQueued = (runId: number, options: DependencyReviewOptions) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const taskRepository = yield* TaskRepository;
    const claude = yield* ClaudeCode;
    const workspace = yield* AgentWorkspace;

    const [run] = yield* db.select().from(agentRuns).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
    if (run === undefined || run.status !== "queued") return Option.none<DependencyReviewOutcome>();
    const task = yield* taskRepository.findTask(run.taskId);
    const [item] = yield* db
      .select({ title: sourceItems.title, url: sourceItems.url })
      .from(taskLinks)
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(and(eq(taskLinks.taskId, run.taskId), eq(taskLinks.role, "tracks")))
      .limit(1)
      .pipe(Effect.orDie);
    const pull = item === undefined ? null : PULL_URL.exec(item.url);
    if (Option.isNone(task) || task.value.status !== "agent_running" || item === undefined || pull === null) {
      yield* db.delete(agentRuns).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
      return Option.none<DependencyReviewOutcome>();
    }
    const target = { taskId: run.taskId, previousStatus: run.previousStatus as TaskStatus, title: item.title, url: item.url, repository: pull[1]! };
    yield* db.update(agentRuns).set({ status: "running", startedAt: yield* nowIso }).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);

    const outcome = yield* Effect.gen(function* () {
      const { cwd, contextDir, headSha } = yield* workspace.prepare(target.repository, target.taskId, target.url);
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
      return { cwd, result, review, headSha };
    }).pipe(Effect.result);

    const finishedAt = yield* nowIso;
    if (outcome._tag === "Success") {
      const { cwd, result, review, headSha } = outcome.success;
      yield* db
        .update(agentRuns)
        .set({
          status: "succeeded",
          result: review,
          subjectSha: headSha ?? null,
          sessionId: result.sessionId,
          costUsd: result.costUsd?.toString() ?? null,
          finishedAt,
        })
        .where(eq(agentRuns.id, runId))
        .pipe(Effect.orDie);
      yield* db
        .insert(agentThreads)
        .values({ taskId: target.taskId, provider: PROVIDER, sessionId: result.sessionId, workspace: cwd, updatedAt: finishedAt })
        .onConflictDoUpdate({ target: agentThreads.taskId, set: { sessionId: result.sessionId, workspace: cwd, updatedAt: finishedAt } })
        .pipe(Effect.orDie);
      const current = Option.getOrThrow(yield* taskRepository.findTask(target.taskId));
      const brief = briefOf(review);
      yield* taskRepository.updateTask(target.taskId, { brief });
      // 結論が出たことを更新マークで知らせる
      yield* taskRepository.recordChange(target.taskId, { kind: "field_changed", field: "brief", before: current.brief, after: brief, unread: true, actor: "agent" });
      yield* moveTask(target.taskId, "agent_running", "todo");
      return Option.some({ taskId: target.taskId, succeeded: true });
    }

    yield* db.update(agentRuns).set({ status: "failed", error: outcome.failure.message, finishedAt }).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
    yield* Effect.logWarning("依存更新の PR を調べられなかった").pipe(Effect.annotateLogs({ taskId: target.taskId, reason: outcome.failure.message }));
    yield* moveTask(target.taskId, "agent_running", target.previousStatus);
    return Option.some({ taskId: target.taskId, succeeded: false });
  });

export class ReviewNotAvailableError extends Schema.TaggedError<ReviewNotAvailableError>()("ReviewNotAvailableError", {
  message: Schema.String,
}) {}

/**
 * ユーザーの依頼で、Task を調査待ちに入れ直す（調査が失敗した・merge に使う commit が残っていないときなど）。
 * 次の回で、前回の session を続けて調べ直す。
 */
export const requestDependencyReview = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const taskRepository = yield* TaskRepository;
  const active = yield* db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.kind, KIND), inArray(agentRuns.status, ["queued", "running"])))
    .limit(1)
    .pipe(Effect.orDie);
  if (active.length > 0) return;

  const task = yield* taskRepository.findTask(taskId);
  const [item] = yield* db
    .select({ url: sourceItems.url, fingerprint: sourceItems.fingerprint })
    .from(taskLinks)
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.role, "tracks")))
    .limit(1)
    .pipe(Effect.orDie);
  if (Option.isNone(task) || item === undefined || PULL_URL.exec(item.url) === null) {
    return yield* new ReviewNotAvailableError({ message: "GitHub の PR を追う Task ではないので調べられない" });
  }
  yield* db
    .insert(agentRuns)
    .values({ taskId, kind: KIND, status: "queued", subjectFingerprint: item.fingerprint, previousStatus: task.value.status, startedAt: yield* nowIso })
    .pipe(Effect.orDie);
  yield* moveTask(taskId, task.value.status, "agent_running");
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

/**
 * アプリが途中で終わり、調査中・調査待ちのまま残ったものを取り消し、Task を元のレーンに戻す。
 * 失敗として残さない理由: 失敗は PR が更新されるまでやり直さないので、アプリを閉じただけで調べられなくなるため。
 * 対象なら次の回で待ちに入れ直す（設定をオフにしたときは、レーンに残さずに済む）。
 */
export const recoverInterruptedAgentRuns = Effect.gen(function* () {
  const db = yield* Database;
  const interrupted = yield* db.select().from(agentRuns).where(inArray(agentRuns.status, ["queued", "running"])).pipe(Effect.orDie);
  for (const run of interrupted) {
    yield* db.delete(agentRuns).where(eq(agentRuns.id, run.id)).pipe(Effect.orDie);
    yield* moveTask(run.taskId, "agent_running", run.previousStatus as TaskStatus);
  }
  return interrupted.filter((run) => run.status === "running").length;
});
