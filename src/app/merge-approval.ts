import { and, desc, eq } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
import { chooseMergeMethod, type MergeMethod } from "../core/agent/merge-method.js";
import { Database } from "../core/db/database.js";
import { agentRuns, approvals, sourceItems, taskLinks } from "../core/db/schema.js";
import { TaskRepository } from "../core/task/task-repository.js";
import type { GitHubClient } from "../sources/github/github-adapter.js";

export class MergeNotAllowedError extends Schema.TaggedError<MergeNotAllowedError>()("MergeNotAllowedError", {
  message: Schema.String,
}) {}

export class MergeFailedError extends Schema.TaggedError<MergeFailedError>()("MergeFailedError", {
  message: Schema.String,
}) {}

export type MergePlan = { repository: string; number: number; sha: string; method: MergeMethod; reason: string };
export type ClientFor<E, R> = (accountId: string) => Effect.Effect<GitHubClient["Service"], E, R>;

const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/;
const SOURCE = /^github:([a-z0-9][a-z0-9-]*)(?::watch)?$/;
const Review = Schema.Struct({ conclusion: Schema.String, canMergeAsIs: Schema.optional(Schema.Boolean) });
const decodeReview = Schema.decodeUnknownOption(Review);

/** 最後の調査が merge 可能と判定した PR と、調べたときの commit。そうでなければ merge させない */
const reviewedPull = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const notAllowed = (message: string) => new MergeNotAllowedError({ message });
  const [run] = yield* db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.kind, "dependency_review")))
    .orderBy(desc(agentRuns.id))
    .limit(1)
    .pipe(Effect.orDie);
  if (run === undefined || run.status !== "succeeded") return yield* notAllowed("merge できると判定した調査がない");
  const review = Option.getOrUndefined(decodeReview(run.result));
  const mergeable = review?.conclusion === "mergeable" || (review?.conclusion === "mergeable_after_fix" && review.canMergeAsIs === true);
  if (!mergeable) return yield* notAllowed("最後の調査で merge 可能と判定されていない");
  if (run.subjectSha === null) return yield* notAllowed("調べたときの commit が分からない（調べていない変更を merge しないため）");

  const [item] = yield* db
    .select({ url: sourceItems.url, source: sourceItems.source })
    .from(taskLinks)
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.role, "tracks")))
    .limit(1)
    .pipe(Effect.orDie);
  const pull = item === undefined ? null : PULL_URL.exec(item.url);
  const account = item === undefined ? null : SOURCE.exec(item.source);
  if (pull === null || account === null) return yield* notAllowed("GitHub の PR を追う Task ではない");
  return { repository: pull[1]!, number: Number(pull[2]), sha: run.subjectSha, accountId: account[1]! };
});

// GitHub の理由（英語）のうち、ユーザーが自分で直せるものは、直し方を添えて伝える
const explainMergeFailure = (message: string) =>
  /without `workflow` scope/.test(message)
    ? "トークンに workflow の権限がないため、.github/workflows を変える PR は merge できません。" +
      "`gh auth refresh -s workflow` で権限を足し、設定画面でトークンを保存し直してから、もう一度 merge してください"
    : message;

/** merge の確認に出す内容。merge の方法はリポジトリの慣習（最近の commit）に合わせて選ぶ */
export const mergePlan = Effect.fnUntraced(function* <E, R>(taskId: number, clientFor: ClientFor<E, R>) {
  const target = yield* reviewedPull(taskId);
  const client = yield* clientFor(target.accountId);
  const allowed = yield* client.getRepository(target.repository);
  const commits = yield* client.listRecentCommits(target.repository);
  const { method, reason } = chooseMergeMethod(allowed, commits);
  return { repository: target.repository, number: target.number, sha: target.sha, method, reason } satisfies MergePlan;
});

/**
 * ユーザーが確認画面で承認した内容（方法と commit）で merge する。承認と結果を approvals に残す。
 * 確認したあとに調べ直して commit が変わっていたら、承認した内容と違うので merge しない。
 */
export const approveAndMerge = Effect.fnUntraced(function* <E, R>(
  taskId: number,
  approved: { method: MergeMethod; sha: string },
  clientFor: ClientFor<E, R>,
) {
  const db = yield* Database;
  const tasks = yield* TaskRepository;
  const target = yield* reviewedPull(taskId);
  if (target.sha !== approved.sha) {
    return yield* new MergeNotAllowedError({ message: "確認したあとに PR が調べ直された。もう一度確認してください" });
  }
  const client = yield* clientFor(target.accountId);
  const approvedAt = DateTime.formatIso(yield* DateTime.now);
  const record = { taskId, action: "merge_pull_request", target: `${target.repository}#${target.number}`, payload: approved, approvedAt };

  const result = yield* client
    .mergePullRequest({ repository: target.repository, number: target.number, sha: approved.sha, method: approved.method })
    .pipe(Effect.result);
  const executedAt = DateTime.formatIso(yield* DateTime.now);
  if (result._tag === "Failure") {
    yield* db.insert(approvals).values({ ...record, status: "failed", error: result.failure.message, executedAt }).pipe(Effect.orDie);
    return yield* new MergeFailedError({ message: explainMergeFailure(result.failure.message) });
  }
  yield* db.insert(approvals).values({ ...record, status: "executed", executedAt }).pipe(Effect.orDie);

  const task = Option.getOrThrow(yield* tasks.findTask(taskId));
  if (task.status !== "done") {
    yield* tasks.updateTask(taskId, { status: "done" });
    yield* tasks.recordChange(taskId, { kind: "field_changed", field: "status", before: task.status, after: "done", unread: false, actor: "user" });
  }
  return result.success;
});
