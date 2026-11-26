import { and, desc, eq, inArray } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
import { ClaudeCode } from "../core/agent/claude-code.js";
import { ConflictWorkspace } from "../core/agent/conflict-workspace.js";
import {
  decodePullRequestFix,
  PULL_FIX_DISALLOWED_TOOLS,
  PULL_FIX_JSON_SCHEMA,
  PULL_FIX_TOOLS,
  type PullRequestFix,
  pullRequestFixPrompt,
} from "../core/agent/pull-request-fix.js";
import { Database } from "../core/db/database.js";
import { agentRuns, approvals } from "../core/db/schema.js";
import { completeStep, currentSteps, decodePlan } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import type { TaskStatus } from "../core/task/task.js";
import { conflictTarget } from "./conflict-resolution-flow.js";

export class PullRequestFixError extends Schema.TaggedError<PullRequestFixError>()("PullRequestFixError", { message: Schema.String }) {}

export const FIX_KIND = "fix_pull_request";

export type PullRequestFixResult = PullRequestFix & { repository: string; headRef: string; commitSha: string; diff: string; cwd: string; step: string };

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (message: string) => new PullRequestFixError({ message });
const messageOf = (error: unknown) => (typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error));
const RequiredChanges = Schema.Struct({ requiredChanges: Schema.String });

const moveTask = Effect.fnUntraced(function* (taskId: number, to: TaskStatus, actor: "user" | "agent") {
  const tasks = yield* TaskRepository;
  const task = Option.getOrThrow(yield* tasks.findTask(taskId));
  if (task.status === to) return;
  yield* tasks.updateTask(taskId, { status: to });
  yield* tasks.recordChange(taskId, { kind: "field_changed", field: "status", before: task.status, after: to, unread: false, actor });
});

/** いま着手できる「修正して push する」手順 */
const fixStepOf = Effect.fnUntraced(function* (taskId: number) {
  const task = Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId));
  const plan = decodePlan(task.nextActions);
  const step = Option.isSome(plan) ? currentSteps(plan.value).find((candidate) => candidate.kind === "fix_and_push") : undefined;
  return { task, plan, step };
});

/** Claude Code に PR を修正させ始める。Task を処理中のレーンに移し、直すのは finishPullRequestFix で裏で行う */
export const startPullRequestFix = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  yield* conflictTarget(taskId);
  const { task, step } = yield* fixStepOf(taskId);
  if (step === undefined) return yield* failure("いま着手できる「修正して push する」手順がない");
  const running = yield* db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), inArray(agentRuns.status, ["queued", "running"])))
    .pipe(Effect.orDie);
  if (running.length > 0) return yield* failure("この Task は、ほかの処理の最中");
  const [run] = yield* db
    .insert(agentRuns)
    .values({ taskId, kind: FIX_KIND, status: "running", subjectFingerprint: "", previousStatus: task.status, startedAt: yield* nowIso })
    .returning({ id: agentRuns.id })
    .pipe(Effect.orDie);
  yield* moveTask(taskId, "agent_running", "user");
  return run!.id;
});

export type PullRequestFixOptions = {
  model?: string;
  maxBudgetUsd?: number;
  /** sandbox の中から読ませない場所（アプリのデータ・ソース・作業場所の置き場全体など）。認証情報の置き場はここで足す */
  denyRead?: ReadonlyArray<string>;
  home?: string;
};

// 依存の更新に要る通信先だけを許す
const PACKAGE_REGISTRIES = ["registry.npmjs.org", "registry.yarnpkg.com"];
const credentialPaths = (home: string | undefined) =>
  home === undefined ? [] : [".ssh", ".config", ".aws", ".npmrc", ".yarnrc.yml", ".netrc", ".git-credentials", ".docker", ".kube", ".gnupg", ".pypirc", ".claude", ".claude.json"].map((path) => `${home}/${path}`);

const fix = Effect.fnUntraced(function* (runId: number, options: PullRequestFixOptions) {
  const db = yield* Database;
  const claude = yield* ClaudeCode;
  const workspace = yield* ConflictWorkspace;
  const [run] = yield* db.select().from(agentRuns).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
  if (run === undefined) return yield* failure("記録が見つからない");
  const pull = yield* conflictTarget(run.taskId);
  const { step } = yield* fixStepOf(run.taskId);
  if (step === undefined) return yield* failure("いま着手できる「修正して push する」手順がない");
  const [review] = yield* db
    .select({ result: agentRuns.result })
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, run.taskId), eq(agentRuns.kind, "dependency_review"), eq(agentRuns.status, "succeeded")))
    .orderBy(desc(agentRuns.id))
    .limit(1)
    .pipe(Effect.orDie);
  const requiredChanges = Option.match(Schema.decodeUnknownOption(RequiredChanges)(review?.result), {
    onNone: () => "（調査の記録はない。手順のタイトルとリポジトリの中身から判断する）",
    onSome: (found) => found.requiredChanges,
  });

  const prepared = yield* workspace.prepare(run.taskId, pull.url, { purpose: "fix" });
  const result = yield* claude.run({
    prompt: pullRequestFixPrompt({ branch: prepared.headRef, step: step.title, requiredChanges }),
    cwd: prepared.cwd,
    jsonSchema: PULL_FIX_JSON_SCHEMA,
    allowedTools: PULL_FIX_TOOLS,
    disallowedTools: PULL_FIX_DISALLOWED_TOOLS,
    withoutCredentials: { ghConfigDir: prepared.isolationDir },
    sandbox: {
      allowedDomains: PACKAGE_REGISTRIES,
      denyRead: [...credentialPaths(options.home), ...(options.denyRead ?? [])],
      // 作業場所の置き場を塞いだうえで、このタスクの作業ディレクトリとキャッシュだけ読ませる（ほかのタスクの作業場所は読ませない）
      allowRead: [prepared.cwd, prepared.cacheDir],
      allowWrite: [prepared.cacheDir],
    },
    // 作業ディレクトリの外には書けないので、パッケージマネージャーのキャッシュは書いてよい場所に置かせる
    env: {
      npm_config_cache: `${prepared.cacheDir}/npm`,
      npm_config_store_dir: `${prepared.cacheDir}/pnpm`,
      YARN_CACHE_FOLDER: `${prepared.cacheDir}/yarn`,
      // ユーザーと全体の npm の設定（レジストリのトークンが入りうる）を読ませず、publish などの書き込みをできなくする
      npm_config_userconfig: "/dev/null",
      npm_config_globalconfig: "/dev/null",
    },
    model: options.model,
    maxBudgetUsd: options.maxBudgetUsd,
  });
  const answer = yield* decodePullRequestFix(result.structured).pipe(Effect.mapError(() => failure("AI の回答の形が違う")));
  const committed = yield* workspace.commit(prepared.cwd, [], {
    anyChanges: true,
    message: step.title,
    repository: prepared.repository,
    headRef: prepared.headRef,
    headSha: prepared.headSha,
  });
  const stored: PullRequestFixResult = { ...answer, repository: prepared.repository, headRef: prepared.headRef, commitSha: committed.commitSha, diff: committed.diff, cwd: prepared.cwd, step: step.title };
  return { run, stored, headSha: prepared.headSha, sessionId: result.sessionId, costUsd: result.costUsd };
});

/** 裏で PR を修正させる。結果（成功・失敗）は Task と記録に残すので、失敗は返さない */
export const finishPullRequestFix = (runId: number, options: PullRequestFixOptions) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const tasks = yield* TaskRepository;
    const [run] = yield* db.select().from(agentRuns).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
    if (run === undefined) return;
    const outcome = yield* fix(runId, options).pipe(Effect.result);
    const finishedAt = yield* nowIso;
    if (outcome._tag === "Failure") {
      const message = messageOf(outcome.failure);
      yield* db.update(agentRuns).set({ status: "failed", error: message, finishedAt }).where(eq(agentRuns.id, runId)).pipe(Effect.orDie);
      yield* moveTask(run.taskId, run.previousStatus as TaskStatus, "agent");
      yield* tasks.recordChange(run.taskId, { kind: "field_changed", field: "fix", before: null, after: `Claude Code が修正できなかった: ${message}`, unread: true, actor: "agent" });
      return;
    }
    const { stored, headSha, sessionId, costUsd } = outcome.success;
    yield* db
      .update(agentRuns)
      .set({ status: "succeeded", result: stored, subjectSha: headSha, sessionId, costUsd: costUsd?.toString() ?? null, finishedAt })
      .where(eq(agentRuns.id, runId))
      .pipe(Effect.orDie);
    yield* moveTask(run.taskId, run.previousStatus as TaskStatus, "agent");
    yield* tasks.recordChange(run.taskId, { kind: "field_changed", field: "fix", before: null, after: `Claude Code が修正した: ${stored.summary}`, unread: true, actor: "agent" });
  });

/** 最後に修正させた記録（まだ push していないもの）。push の確認に出す */
export const latestPullRequestFix = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const [run] = yield* db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.kind, FIX_KIND), eq(agentRuns.status, "succeeded")))
    .orderBy(desc(agentRuns.id))
    .limit(1)
    .pipe(Effect.orDie);
  if (run === undefined || run.subjectSha === null) return Option.none<{ runId: number; headSha: string; result: PullRequestFixResult }>();
  return Option.some({ runId: run.id, headSha: run.subjectSha, result: run.result as PullRequestFixResult });
});

/**
 * 外部への書き込み。ユーザーが差分を確かめて承認したあとにだけ呼ぶ。確認画面で見せた commit が最新の修正と同じで、
 * 直し始めたときの PR の head から動いていなければ、その commit を名指しで push し、修正の手順を済ませる
 */
export const pushPullRequestFix = Effect.fnUntraced(function* <E, R>(
  taskId: number,
  approvedCommitSha: string,
  tokenFor: (accountId: string) => Effect.Effect<string, E, R>,
) {
  const db = yield* Database;
  const tasks = yield* TaskRepository;
  const workspace = yield* ConflictWorkspace;
  const latest = yield* latestPullRequestFix(taskId);
  if (Option.isNone(latest)) return yield* failure("Claude Code が修正した記録がない");
  const { runId, headSha, result } = latest.value;
  if (result.commitSha !== approvedCommitSha) return yield* failure("確認したあとに修正し直された。もう一度確かめてから push してください");
  const pull = yield* conflictTarget(taskId);
  const token = yield* tokenFor(pull.accountId);
  const record = {
    taskId,
    action: "push_fix",
    target: `${pull.repository}#${pull.number}`,
    payload: { runId, headRef: result.headRef, commitSha: result.commitSha, baseSha: headSha },
    approvedAt: yield* nowIso,
  };
  const pushed = yield* workspace.push(result.cwd, result.repository, result.headRef, headSha, result.commitSha, token).pipe(Effect.result);
  const executedAt = yield* nowIso;
  if (pushed._tag === "Failure") {
    yield* db.insert(approvals).values({ ...record, status: "failed", error: pushed.failure.message, executedAt }).pipe(Effect.orDie);
    return yield* failure(pushed.failure.message);
  }
  yield* db.insert(approvals).values({ ...record, status: "executed", executedAt }).pipe(Effect.orDie);
  const { plan, step } = yield* fixStepOf(taskId);
  if (Option.isSome(plan) && step !== undefined) yield* tasks.updateTask(taskId, { nextActions: completeStep(plan.value, step.id) }, "user");
  yield* tasks.recordChange(taskId, { kind: "field_changed", field: "fix", before: null, after: `直した内容を ${result.headRef} に push した`, unread: false, actor: "user" });
});
