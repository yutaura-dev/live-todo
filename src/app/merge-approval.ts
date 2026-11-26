import { and, desc, eq } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
import { chooseMergeMethod, type MergeMethod } from "../core/agent/merge-method.js";
import { Database } from "../core/db/database.js";
import { agentRuns, approvals, sourceItems, taskLinks } from "../core/db/schema.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { completeStep, currentSteps, decodePlan } from "../core/task/next-actions.js";
import { isDependencyBot } from "../core/agent/dependency-review.js";
import type { TaskStatus } from "../core/task/task.js";
import type { GitHubClient } from "../sources/github/github-adapter.js";

export class MergeNotAllowedError extends Schema.TaggedError<MergeNotAllowedError>()("MergeNotAllowedError", {
  message: Schema.String,
}) {}

export class MergeFailedError extends Schema.TaggedError<MergeFailedError>()("MergeFailedError", {
  message: Schema.String,
}) {}

export type MergePlan = { repository: string; number: number; sha: string; method: MergeMethod; reason: string };
export type ClientFor<E, R> = (accountId: string) => Effect.Effect<GitHubClient["Service"], E, R>;

const MERGE_KIND = "merge_pull_request";
const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/;
const SOURCE = /^github:([a-z0-9][a-z0-9-]*)(?::watch)?$/;
const Review = Schema.Struct({ conclusion: Schema.String, canMergeAsIs: Schema.optional(Schema.Boolean) });
const decodeReview = Schema.decodeUnknownOption(Review);

/** Task が追う GitHub の PR と、そのアカウント */
const trackedPull = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const items = yield* db
    .select({ url: sourceItems.url, source: sourceItems.source, author: sourceItems.author })
    .from(taskLinks)
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.role, "tracks")))
    .pipe(Effect.orDie);
  for (const item of items) {
    const pull = PULL_URL.exec(item.url);
    const account = SOURCE.exec(item.source);
    if (pull !== null && account !== null) {
      return { repository: pull[1]!, number: Number(pull[2]), accountId: account[1]!, author: item.author };
    }
  }
  return yield* new MergeNotAllowedError({ message: "GitHub の PR を追う Task ではない" });
});

const LivePull = Schema.Struct({
  state: Schema.String,
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable_state: Schema.optional(Schema.NullOr(Schema.String)),
  head: Schema.Struct({ sha: Schema.String }),
});
const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String, conclusion: Schema.optional(Schema.NullOr(Schema.String)) })),
});
const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
// GitHub の mergeable_state のうち clean 以外の理由を、ユーザーに伝わる言葉にする
const MERGEABLE_STATE_REASONS: Record<string, string> = {
  dirty: "コンフリクトがある",
  blocked: "必要な承認やチェックが足りず、GitHub が merge を止めている",
  behind: "ベースのブランチより古い（更新が要る）",
  unstable: "通っていない CI がある",
  draft: "draft の PR",
  unknown: "GitHub がまだ merge できるかを計算している。少し待ってからもう一度押してください",
};

/**
 * merge してよい PR と、merge する commit。
 * 依存更新の PR は、調査が merge 可能と判定したときの commit。
 * それ以外（自分の PR など）は、今の PR を GitHub で確かめ、CI がすべて通ってコンフリクトもないときの head の commit。
 */
const mergeTarget = Effect.fnUntraced(function* <E, R>(taskId: number, clientFor: ClientFor<E, R>) {
  const db = yield* Database;
  const notAllowed = (message: string) => new MergeNotAllowedError({ message });
  const pull = yield* trackedPull(taskId);
  const reviews = yield* db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.kind, "dependency_review")))
    .orderBy(desc(agentRuns.id))
    .pipe(Effect.orDie);
  // 最後に成功した調査を使う。そのあとの調べ直しが（作業場所の取得などで）失敗しても、結論は変わらないため
  const run = reviews.find((candidate) => candidate.status === "succeeded");
  if (reviews.length > 0 || isDependencyBot(pull.author)) {
    if (run === undefined) return yield* notAllowed("依存更新の PR は、調査で merge できると判定されてから merge できる（merge できると判定した調査がない）");
    const review = Option.getOrUndefined(decodeReview(run.result));
    const mergeable = review?.conclusion === "mergeable" || (review?.conclusion === "mergeable_after_fix" && review.canMergeAsIs === true);
    if (!mergeable) return yield* notAllowed("最後の調査で merge 可能と判定されていない");
    if (run.subjectSha === null) return yield* notAllowed("調べたときの commit が分からない（調べていない変更を merge しないため）");
    return { repository: pull.repository, number: pull.number, sha: run.subjectSha, accountId: pull.accountId };
  }

  const client = yield* clientFor(pull.accountId);
  const raw = yield* client.getPullRequest(`https://api.github.com/repos/${pull.repository}/pulls/${pull.number}`);
  if (Option.isNone(raw)) return yield* notAllowed("PR が見つからない");
  const live = yield* Schema.decodeUnknownEffect(LivePull)(raw.value).pipe(Effect.mapError(() => notAllowed("PR の状態を読めない")));
  if (live.state !== "open") return yield* notAllowed("PR が開いていない");
  if (live.draft === true) return yield* notAllowed("draft の PR は merge できない");
  const checks = yield* client
    .listCheckRuns(pull.repository, live.head.sha)
    .pipe(Effect.flatMap((body) => Schema.decodeUnknownEffect(CheckRuns)(body).pipe(Effect.mapError(() => notAllowed("CI の結果を読めない")))));
  const pending = checks.check_runs.filter((check) => check.status !== "completed").map((check) => check.name);
  if (pending.length > 0) return yield* notAllowed(`CI がまだ終わっていない: ${pending.join(", ")}`);
  const failing = checks.check_runs.filter((check) => !PASSING_CONCLUSIONS.has(check.conclusion ?? "")).map((check) => check.name);
  if (failing.length > 0) return yield* notAllowed(`CI が通っていない: ${failing.join(", ")}`);
  const state = live.mergeable_state ?? "unknown";
  if (state !== "clean") return yield* notAllowed(`merge できる状態ではない: ${MERGEABLE_STATE_REASONS[state] ?? state}`);
  return { repository: pull.repository, number: pull.number, sha: live.head.sha, accountId: pull.accountId };
});

// GitHub の理由（英語）のうち、ユーザーが自分で直せるものは、直し方を添えて伝える
const explainMergeFailure = (message: string, status: number | undefined) =>
  status !== undefined && status >= 500
    ? "GitHub 側のエラーで merge できませんでした（理由は返ってきていません）。" +
      "GitHub の画面からなら merge できることがあるので、PR を開いて merge してください。merge すると、次の同期でこの Task も完了になります"
    : /without `workflow` scope/.test(message)
    ? "トークンに workflow の権限がないため、.github/workflows を変える PR は merge できません。" +
      "`gh auth refresh -s workflow` で権限を足し、設定画面でトークンを保存し直してから、もう一度 merge してください"
    : message;

/** merge の確認に出す内容。merge の方法はリポジトリの慣習（最近の commit）に合わせて選ぶ */
export const mergePlan = Effect.fnUntraced(function* <E, R>(taskId: number, clientFor: ClientFor<E, R>) {
  const target = yield* mergeTarget(taskId, clientFor);
  const client = yield* clientFor(target.accountId);
  const allowed = yield* client.getRepository(target.repository);
  const commits = yield* client.listRecentCommits(target.repository);
  const { method, reason } = chooseMergeMethod(allowed, commits);
  return { repository: target.repository, number: target.number, sha: target.sha, method, reason } satisfies MergePlan;
});

/**
 * merge を始める。確認画面で承認した内容（方法と commit）を今の調査と照らし、合っていれば Task を処理中のレーンに移す。
 * 実際の merge は finishMerge で裏で行う（画面を待たせないため）。確認したあとに調べ直して commit が変わっていたら始めない。
 */
export const startMerge = Effect.fnUntraced(function* <E, R>(taskId: number, approved: { method: MergeMethod; sha: string }, clientFor: ClientFor<E, R>) {
  const db = yield* Database;
  const tasks = yield* TaskRepository;
  const target = yield* mergeTarget(taskId, clientFor);
  if (target.sha !== approved.sha) {
    return yield* new MergeNotAllowedError({ message: "確認したあとに PR が変わった（調べ直された・commit が足された）。もう一度確認してください" });
  }
  const task = Option.getOrThrow(yield* tasks.findTask(taskId));
  const [run] = yield* db
    .insert(agentRuns)
    .values({
      taskId,
      kind: MERGE_KIND,
      status: "running",
      subjectFingerprint: "",
      subjectSha: approved.sha,
      previousStatus: task.status,
      startedAt: DateTime.formatIso(yield* DateTime.now),
    })
    .returning({ id: agentRuns.id })
    .pipe(Effect.orDie);
  if (task.status !== "agent_running") {
    yield* tasks.updateTask(taskId, { status: "agent_running" });
    yield* tasks.recordChange(taskId, { kind: "field_changed", field: "status", before: task.status, after: "agent_running", unread: false, actor: "user" });
  }
  return run!.id;
});

const executeMerge = Effect.fnUntraced(function* <E, R>(runId: number, approved: { method: MergeMethod; sha: string }, clientFor: ClientFor<E, R>) {
  const db = yield* Database;
  const tasks = yield* TaskRepository;
  const [run] = yield* db.select().from(agentRuns).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
  if (run === undefined) return yield* new MergeNotAllowedError({ message: "merge の記録が見つからない" });
  const taskId = run.taskId;
  const previousStatus = run.previousStatus as TaskStatus;
  const target = yield* trackedPull(taskId);
  const client = yield* clientFor(target.accountId);
  const approvedAt = DateTime.formatIso(yield* DateTime.now);
  const record = { taskId, action: "merge_pull_request", target: `${target.repository}#${target.number}`, payload: approved, approvedAt };

  const result = yield* client
    .mergePullRequest({ repository: target.repository, number: target.number, sha: approved.sha, method: approved.method })
    .pipe(Effect.result);
  const executedAt = DateTime.formatIso(yield* DateTime.now);
  const current = Option.getOrThrow(yield* tasks.findTask(taskId)).status;
  if (result._tag === "Failure") {
    const message = explainMergeFailure(result.failure.message, "status" in result.failure ? result.failure.status : undefined);
    yield* db.insert(approvals).values({ ...record, status: "failed", error: result.failure.message, executedAt }).pipe(Effect.orDie);
    yield* db.update(agentRuns).set({ status: "failed", error: result.failure.message, finishedAt: executedAt }).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
    if (current === "agent_running") {
      yield* tasks.updateTask(taskId, { status: previousStatus });
      yield* tasks.recordChange(taskId, { kind: "field_changed", field: "status", before: current, after: previousStatus, unread: false, actor: "agent" });
    }
    // 裏で失敗したことに気づけるよう、更新マークを付ける
    yield* tasks.recordChange(taskId, { kind: "field_changed", field: "merge", before: null, after: message, unread: true, actor: "agent" });
    return yield* new MergeFailedError({ message });
  }
  yield* db.insert(approvals).values({ ...record, status: "executed", executedAt }).pipe(Effect.orDie);
  yield* db.update(agentRuns).set({ status: "succeeded", finishedAt: executedAt }).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
  // merge の手順を済ませる。ほかに手順が残っていなければ、手順が済んだことで Task は完了になる
  const task = Option.getOrThrow(yield* tasks.findTask(taskId));
  const plan = decodePlan(task.nextActions);
  const mergeStep = Option.isSome(plan) ? currentSteps(plan.value).find((step) => step.kind === "merge_pull_request") : undefined;
  if (Option.isSome(plan) && mergeStep !== undefined) {
    if (current === "agent_running") yield* tasks.updateTask(taskId, { status: previousStatus });
    yield* tasks.updateTask(taskId, { nextActions: completeStep(plan.value, mergeStep.id) }, "user");
  } else if (current !== "done") {
    yield* tasks.updateTask(taskId, { status: "done" });
    yield* tasks.recordChange(taskId, { kind: "field_changed", field: "status", before: current, after: "done", unread: false, actor: "user" });
  }
  return result.success;
});

/** 裏で merge する。結果（成功・失敗）は Task と記録に残すので、ここでは失敗を返さない */
export const finishMerge = <E, R>(runId: number, approved: { method: MergeMethod; sha: string }, clientFor: ClientFor<E, R>) =>
  executeMerge(runId, approved, clientFor).pipe(
    Effect.catch((error: unknown) =>
      Effect.logWarning("merge できなかった").pipe(
        Effect.annotateLogs({ runId, reason: typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error) }),
      ),
    ),
    Effect.asVoid,
  );

/** merge を始めて、終わるまで待つ */
export const approveAndMerge = Effect.fnUntraced(function* <E, R>(
  taskId: number,
  approved: { method: MergeMethod; sha: string },
  clientFor: ClientFor<E, R>,
) {
  const runId = yield* startMerge(taskId, approved, clientFor);
  return yield* executeMerge(runId, approved, clientFor);
});
