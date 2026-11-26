import { join } from "node:path";
// まとめた入口（"@effect/platform-node"）から読まない理由: 使わない NodeRedis まで読み込み、配る版に入らない redis（省略できる依存）を探して起動に失敗するため
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cache, Cause, DateTime, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { loadAppConfigFile, readAppConfigDocument, saveAppConfigFile } from "../app/config/app-config.js";
import { dismissTasksOutsideFilter } from "../app/filter-cleanup.js";
import { makeGitHubJobs } from "../app/github-jobs.js";
import { makeSlackJobs } from "../app/slack-jobs.js";
import { and, eq, like } from "drizzle-orm";
import { sourceItems, taskLinks } from "../core/db/schema.js";
import { makeGmailJobs } from "../app/gmail-jobs.js";
import { applyGmailRules } from "../sources/gmail/gmail-rule-runner.js";
import { MailClassifier } from "../core/judge/mail-classifier.js";
import { makeMailClassifier } from "../app/llm.js";
import { runGmailThreadTriage } from "../app/gmail-conversations.js";
import {
  acceptSuggestion,
  answerQuestion,
  askQuestion,
  dismissSuggestion,
  listQuestions,
  recoverInterruptedQuestions,
  TaskQuestionError,
  type TaskSuggestion,
} from "../app/task-questions.js";
import { actionsFromInterpretation, labelCandidatesOf } from "../core/rules/interpret.js";
import { decodePlan, stepLinkOf } from "../core/task/next-actions.js";
import { gmailMailTarget, gmailProcess, gmailRunStep, GmailWriteError } from "../app/gmail-write.js";import { GmailClient } from "../sources/gmail/gmail-client.js";
import { GmailClientLive, Gws } from "../sources/gmail/gmail-client-live.js";
import { withSlackSession } from "../app/slack-session.js";
import { releaseUntouchedInboxTasks, runSlackConversationTriage } from "../app/slack-conversations.js";
import { captureSlackSession } from "./slack-connect.js";
import { captureNotionSession } from "./notion-connect.js";
import { withNotionSession } from "../app/notion-session.js";
import { makeNotionJobs, notionTokenKey } from "../app/notion-jobs.js";
import { makeCalendarJobs } from "../app/calendar-jobs.js";
import { loginShellPath, mergePath } from "../app/login-shell-path.js";
import { graphClientFor, makeMicrosoftJobs, microsoftAppOf, microsoftRefreshTokenKey } from "../app/microsoft-jobs.js";
import { type DeviceCode, type MicrosoftApp, pollDeviceToken, requestDeviceCode } from "../sources/microsoft/microsoft-auth.js";
import { NotionClient, NotionRequestError } from "../sources/notion/notion-client.js";
import { NotionClientLive } from "../sources/notion/notion-client-live.js";
import { SlackClient, SlackRequestError } from "../sources/slack/slack-client.js";
import { slackWrite } from "../app/slack-write.js";
import {
  createRecurringFromTask,
  createRecurringNow,
  createRecurringTask,
  upcomingRecurringTasks,
  listRecurringTasks,
  localToday,
  runRecurringTasks,
  updateRecurringActive,
  updateRecurringTask,
} from "../app/recurring-tasks.js";
import { SlackClientLive } from "../sources/slack/slack-client-live.js";
import { previewAccountFilter } from "../app/settings/filter-preview.js";
import { finishMerge, mergePlan, startMerge } from "../app/merge-approval.js";
import { applyConflictPlans } from "../app/conflict-plans.js";
import { completeFinishedPlans } from "../app/finished-plans.js";
import { upgradeMergeSteps } from "../app/merge-steps.js";
import {
  conflictTarget,
  finishConflictResolution,
  latestConflictResolution,
  pushConflictResolution,
  startConflictResolution,
} from "../app/conflict-resolution-flow.js";
import { ConflictWorkspace } from "../core/agent/conflict-workspace.js";
import { finishPullRequestFix, latestPullRequestFix, pushPullRequestFix, startPullRequestFix } from "../app/pull-request-fix-flow.js";
import { makeTokenInfoStore } from "../app/settings/token-info-store.js";
import { missingRecommendedScopes, tokenExpiryWarning, verifyGitHubToken } from "../app/settings/verify-github-token.js";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode } from "../core/agent/claude-code.js";
import { backfillNextActions, recoverInterruptedAgentRuns, requestDependencyReview, runDependencyReviews } from "../core/agent/dependency-triage.js";
import { requestReplan, runNextActionPlanning } from "../core/agent/next-action-runner.js";
import { recoverInterruptedStepRuns, runAutoSteps, runStep, StepRunError, startStepRun } from "../app/step-runs.js";
import { BoardService } from "../core/board/board-service.js";
import { encryptedFileSecretStore, type SecretCipher, SecretVault } from "../core/config/encrypted-secret-store.js";
import { SecretStore } from "../core/config/secret-store.js";
import { Database, databaseMigrationsFrom } from "../core/db/database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { runJobs, type SyncJob } from "../core/sync/scheduler.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { GitHubClient, GitHubRequestError } from "../sources/github/github-adapter.js";
import { GitHubClientLive } from "../sources/github/github-client-live.js";
import type { GitHubTokenSummary, Outcome, SecretStatus, SettingsSnapshot } from "../shared/api.js";
import {
  decodeConflictPushRequest,
  decodeFilterPreviewRequest,
  decodeMergeRequest,
  decodeStepRequest,
  decodeMoveRequest,
  decodeSecretInput,
  decodeSecretKey,
  decodeTaskId,
  IPC_CHANNELS,
  isAllowedExternalUrl,
} from "./ipc.js";

// 開発中はリポジトリの config.json と live-todo.db を使い、配布したアプリではユーザーごとのデータの置き場所を使う
const dataPath = (name: string) => (app.isPackaged ? join(app.getPath("userData"), name) : join(process.cwd(), name));
const dbPath = process.env["LIVE_TODO_DB"] ?? dataPath("live-todo.db");
const configPath = process.env["LIVE_TODO_CONFIG"] ?? dataPath("config.json");
const smokeTest = process.env["LIVE_TODO_SMOKE"] === "1";
// 開発用: 指定したパスに画面の PNG を保存して終了する（見た目を確かめるため）
const screenshotPath = process.env["LIVE_TODO_SCREENSHOT"];
// 開発用: スクリーンショットの前に画面で実行する JavaScript（入力やクリックを再現して撮るため）
const screenshotScript = process.env["LIVE_TODO_SCREENSHOT_SCRIPT"];
// 確認のためだけに起動するときは、作業中の画面にウィンドウを出さない
const headless = smokeTest || screenshotPath !== undefined;
// 確認用の起動は別のユーザーデータを使う。普段使いのアプリが動いていると、同じフォルダの取り合いで起動が止まるため
if (headless) app.setPath("userData", join(app.getPath("temp"), "live-todo-check"));
// 開発中もリポジトリの中に置かない理由: 暗号化していても、誤ってコミットする経路を作らないため
const secretsPath = join(app.getPath("userData"), "secrets.json");
const tokenInfoPath = join(app.getPath("userData"), "github-tokens.json");
// AI に調べさせるためにリポジトリを clone する場所。Claude Code の session はこの場所に結び付く
const agentWorkspaceRoot = join(app.getPath("userData"), "agent-workspaces");
// 依存更新の PR の調査に使うモデルと、1 回あたりの予算の上限
const DEPENDENCY_REVIEW_MODEL = "sonnet";
const DEPENDENCY_REVIEW_BUDGET_USD = 2;
// 同時に調べる数。並列にすると早く終わるが、増やしすぎると Claude Code の使用量の枠をすぐに使い切る
const DEPENDENCY_REVIEW_CONCURRENCY = 4;
const AGENT_JOB_INTERVAL = "1 minute" as const;
const LLM_SECRET_KEYS = ["llm.anthropic.api_key", "llm.openai.api_key"] as const;

// safeStorage は app の ready 後でないと使えないので、呼ばれた時点で確かめる
const keychainCipher: SecretCipher = {
  isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: async (data) => (await safeStorage.decryptStringAsync(Buffer.from(data))).result,
};

const AppLayer = Layer.mergeAll(BoardService.layer.pipe(Layer.provideMerge(TaskRepository.layer)), SourceItemRepository.layer).pipe(
  Layer.provideMerge(databaseMigrationsFrom(join(app.getAppPath(), "drizzle"))),
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(SqliteClient.layer({ filename: dbPath })),
  Layer.provideMerge(encryptedFileSecretStore({ path: secretsPath, cipher: keychainCipher })),
  Layer.provideMerge(Layer.mergeAll(ClaudeCode.layer, AgentWorkspace.layer(agentWorkspaceRoot), ConflictWorkspace.layer(agentWorkspaceRoot))),
  Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
);
const runtime = ManagedRuntime.make(AppLayer);
// 使うたびに作る理由: 中身はファイルの読み書きだけで、書くのはトークンを保存・削除したときに限られるため
const tokenInfoStore = makeTokenInfoStore(tokenInfoPath);
// プレビューは入力のたびに呼ばれるので、GitHub の一覧（数ページの取得）は数分間覚えておく。失敗は覚えない（トークンを直したらすぐ取り直す）
const REMOTE_REPOSITORIES_TTL = "5 minutes";
const remoteRepositories = runtime.runPromise(
  Cache.makeWith(
    (accountId: string) =>
      Effect.gen(function* () {
        const token = yield* (yield* SecretStore).get(`github.${accountId}.token`);
        if (Option.isNone(token)) return yield* new GitHubRequestError({ message: "このアカウントのトークンが登録されていない" });
        const http = yield* HttpClient.HttpClient;
        return yield* Effect.gen(function* () {
          return yield* (yield* GitHubClient).listMyRepositories;
        }).pipe(Effect.provide(GitHubClientLive({ token: token.value })), Effect.provideService(HttpClient.HttpClient, http));
      }),
    { capacity: 16, timeToLive: (exit) => (Exit.isSuccess(exit) ? REMOTE_REPOSITORIES_TTL : 0) },
  ),
);
const forgetRemoteRepositories = (accountId: string | undefined) =>
  accountId === undefined ? Effect.void : Effect.flatMap(Effect.promise(() => remoteRepositories), (cache) => Cache.invalidate(cache, accountId));

const accountOfTokenKey = (key: string) => /^github\.(.+)\.token$/.exec(key)?.[1];

let syncFiber: Fiber.Fiber<unknown, unknown> | undefined;
let syncProblem: string | undefined;

const startSync = Effect.gen(function* () {
  const config = yield* loadAppConfigFile(configPath);
  for (const account of config.accounts) {
    const dismissed = yield* dismissTasksOutsideFilter(account.id, account.repositories ?? {});
    if (dismissed > 0) yield* Effect.log(`フィルタで除外したリポジトリの Task を ${dismissed} 件片付けた`).pipe(Effect.annotateLogs({ account: account.id }));
  }
  const jobs = (yield* Effect.forEach(config.accounts, makeGitHubJobs)).flat();
  syncProblem = undefined;
  // Slack は 1 つのワークスペースのセッションが切れても、ほかの同期は止めない（理由は設定画面に出す）
  const slackJobs = (
    yield* Effect.forEach(config.slackAccounts, (account) =>
      makeSlackJobs(account).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            syncProblem = `Slack（${account.id}）の同期を始められない: ${error.message}`;
            return [];
          }),
        ),
      ),
    )
  ).flat();
  // Notion も、1 つのアカウントのセッションが切れても、ほかの同期は止めない
  const notionJobs = (
    yield* Effect.forEach(config.notionAccounts, (account) =>
      makeNotionJobs(account).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            syncProblem = `Notion（${account.id}）の同期を始められない: ${errorMessage(error)}`;
            return [];
          }),
        ),
      ),
    )
  ).flat();
  // 終日の予定の日付は、この PC のタイムゾーンで読む（Graph のタイムゾーン名は Windows の名前で、IANA に直す表が要るため）
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const microsoftJobs = (
    yield* Effect.forEach(config.microsoftAccounts, (account) =>
      makeMicrosoftJobs(account, { timeZone: localTimeZone }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            syncProblem = `Microsoft（${account.id}）の同期を始められない: ${errorMessage(error)}`;
            return [];
          }),
        ),
      ),
    )
  ).flat();
  const calendarJobs = (
    yield* Effect.forEach(
      config.gmailAccounts.filter((account) => account.calendar),
      (account) =>
      makeCalendarJobs(account).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            syncProblem = `Calendar（${account.id}）の同期を始められない: ${errorMessage(error)}`;
            return [];
          }),
        ),
      ),
    )
  ).flat();
  const gmailJobs = (
    yield* Effect.forEach(config.gmailAccounts, (account) =>
      makeGmailJobs(account, config.rules, { invitesHandledByCalendar: account.calendar }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            syncProblem = `Gmail（${account.id}）の同期を始められない: ${errorMessage(error)}`;
            return [];
          }),
        ),
      ),
    )
  ).flat();

  yield* backfillNextActions;
  yield* applyConflictPlans;
  yield* completeFinishedPlans;
  yield* upgradeMergeSteps;
  const interruptedQuestions = yield* recoverInterruptedQuestions;
  if (interruptedQuestions > 0) yield* Effect.log(`途中で止まった質問を ${interruptedQuestions} 件、失敗として残した`);
  const interruptedSteps = yield* recoverInterruptedStepRuns;
  if (interruptedSteps > 0) yield* Effect.log(`途中で止まった Claude Code の手順を ${interruptedSteps} 件、できなかったとして残した`);
  const recovered = yield* recoverInterruptedAgentRuns;
  if (recovered > 0) yield* Effect.log(`途中で止まった AI の調査を ${recovered} 件戻した`);
  const reviewSources = config.accounts
    .filter((account) => account.reviewDependencyPrs)
    .flatMap((account) => [`github:${account.id}`, `github:${account.id}:watch`]);
  const planSources = [
    ...config.accounts.filter((account) => account.planNextActions).flatMap((account) => [`github:${account.id}`, `github:${account.id}:watch`]),
    ...config.slackAccounts.filter((account) => account.planNextActions).flatMap((account) => [`slack:${account.id}`, `slack:${account.id}:inbox`]),
    // 送り主の Task はアプリが手順を決めるので、Claude Code に考えさせるのは人からのメールのスレッドだけ
    ...config.gmailAccounts.filter((account) => account.planNextActions).map((account) => `gmail:${account.id}:threads`),
  ];
  // Slack の会話から Task を決める（メッセージ本文を Claude に送るので、Claude Code で考えるのを有効にしたワークスペースだけ）
  const conversationAccounts = config.slackAccounts.filter((account) => account.planNextActions);
  for (const account of conversationAccounts) {
    const released = yield* releaseUntouchedInboxTasks(account.id);
    if (released > 0) yield* Effect.log(`メッセージ 1 件ごとに作っていた Slack の Task を ${released} 件片付け、会話ごとに考え直す`);
  }
  const conversationJobs = conversationAccounts.map((account) => ({
    name: `agent:slack-conversations:${account.id}`,
    interval: AGENT_JOB_INTERVAL,
    run: slackClientFor(account.id).pipe(
      Effect.flatMap((client) =>
        runSlackConversationTriage({ accountId: account.id, model: DEPENDENCY_REVIEW_MODEL, maxBudgetUsd: DEPENDENCY_REVIEW_BUDGET_USD }, client),
      ),
      Effect.catch((error) => Effect.logWarning("Slack の会話から Task を決められなかった").pipe(Effect.annotateLogs({ reason: errorMessage(error) }))),
    ),
    backoffUntil: () => Option.none<DateTime.Utc>(),
  }));
  // 人からのメールのスレッドから Task を決める（本文を Claude に送るので、Claude Code で考えるのを有効にしたアカウントだけ）
  const gmailThreadJobs = config.gmailAccounts
    .filter((account) => account.planNextActions)
    .map((account) => ({
      name: `agent:gmail-threads:${account.id}`,
      interval: AGENT_JOB_INTERVAL,
      run: gmailClientFor(account.id).pipe(
        Effect.flatMap((client) => runGmailThreadTriage({ accountId: account.id, model: DEPENDENCY_REVIEW_MODEL, maxBudgetUsd: DEPENDENCY_REVIEW_BUDGET_USD }, client)),
        Effect.catch((error) => Effect.logWarning("メールのスレッドから Task を決められなかった").pipe(Effect.annotateLogs({ reason: errorMessage(error) }))),
      ),
      backoffUntil: () => Option.none<DateTime.Utc>(),
    }));
  const planJobs: ReadonlyArray<SyncJob<never, AgentWorkspace | ClaudeCode | Database | TaskRepository>> =
    planSources.length === 0
      ? []
      : [
          {
            name: "agent:next-actions",
            interval: AGENT_JOB_INTERVAL,
            run: runNextActionPlanning({
              sources: planSources,
              model: DEPENDENCY_REVIEW_MODEL,
              maxBudgetUsd: DEPENDENCY_REVIEW_BUDGET_USD,
              concurrency: DEPENDENCY_REVIEW_CONCURRENCY,
              // メールの Task では、元のメールの本文から手順を考えさせる（件名と要約だけだと、手続きのページや期限が分からないため）
              extraContext: (taskId) => Effect.tryPromise(() => runtime.runPromise(questionContextFor(taskId))),
            }),
            backoffUntil: () => Option.none<DateTime.Utc>(),
          },
        ];
  const agentJobs: ReadonlyArray<SyncJob<never, AgentWorkspace | ClaudeCode | Database | TaskRepository>> =
    reviewSources.length === 0
      ? planJobs
      : [
          ...planJobs,
          {
            name: "agent:dependency-review",
            interval: AGENT_JOB_INTERVAL,
            run: runDependencyReviews({
              sources: reviewSources,
              model: DEPENDENCY_REVIEW_MODEL,
              maxBudgetUsd: DEPENDENCY_REVIEW_BUDGET_USD,
              concurrency: DEPENDENCY_REVIEW_CONCURRENCY,
            }),
            backoffUntil: () => Option.none<DateTime.Utc>(),
          },
        ];

  // 見張りが新しく見つけた conflict の Task にも、アプリで直す手順を入れる
  const conflictPlanJob: SyncJob<never, Database | TaskRepository> = {
    name: "app:conflict-plans",
    interval: AGENT_JOB_INTERVAL,
    run: applyConflictPlans,
    backoffUntil: () => Option.none<DateTime.Utc>(),
  };
  // 番が来た「Claude Code が自動でやる」手順を動かす（Claude Code を使ってよい Task だけ）
  const autoStepJob = {
    name: "agent:auto-steps",
    interval: AGENT_JOB_INTERVAL,
    run: runAutoSteps({ optionsFor: claudeOptionsForTask }).pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logWarning("Claude Code に手順をやらせられなかった").pipe(Effect.annotateLogs({ reason: errorMessage(error) }))),
    ),
    backoffUntil: () => Option.none<DateTime.Utc>(),
  };
  // 日付が変わったら作るものなので、1 時間おきで足りる
  const recurringJob: SyncJob<never, Database | TaskRepository> = {
    name: "app:recurring",
    interval: "1 hour",
    run: localToday.pipe(Effect.flatMap(runRecurringTasks)),
    backoffUntil: () => Option.none<DateTime.Utc>(),
  };
  yield* Effect.log(`同期を始める: ${[...jobs, ...slackJobs, ...notionJobs, ...microsoftJobs, ...calendarJobs, ...gmailJobs, ...agentJobs, ...conversationJobs, ...gmailThreadJobs, conflictPlanJob, recurringJob, autoStepJob].map((job) => job.name).join(", ")}`);
  return yield* Effect.all([runJobs(jobs), runJobs(slackJobs), runJobs(notionJobs), runJobs(microsoftJobs), runJobs(calendarJobs), runJobs(gmailJobs), runJobs(agentJobs), runJobs([conflictPlanJob, recurringJob]), runJobs(conversationJobs), runJobs(gmailThreadJobs), runJobs([autoStepJob])], {
    concurrency: 8,
    discard: true,
  });
}).pipe(
  // 設定やトークンがなくても画面は開けるようにする（同期だけが止まり、設定画面に理由を出す）
  Effect.catchCause((cause) =>
    Effect.gen(function* () {
      const failure = Cause.squash(cause);
      syncProblem = `同期を始められない: ${failure instanceof Error ? `${failure.name} ${failure.message}` : String(failure)}`;
      yield* Effect.logError("同期を始められない").pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) }));
    }),
  ),
);

/** 設定や秘密情報を変えたら、新しい設定で同期をやり直す */
async function restartSync() {
  if (syncFiber !== undefined) await runtime.runPromise(Fiber.interrupt(syncFiber));
  syncFiber = runtime.runFork(startSync);
}

const outcomeOf = <A, E extends { message: string }, R extends ManagedRuntime.ManagedRuntime.Services<typeof runtime>>(
  effect: Effect.Effect<A, E, R>,
): Promise<Outcome> =>
  runtime.runPromise(
    effect.pipe(
      Effect.as({ ok: true } as const),
      Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
    ),
  );

const settingsSnapshot = Effect.gen(function* () {
  const problems: string[] = [];
  const document = yield* readAppConfigDocument(configPath).pipe(
    Effect.catch((error) => {
      problems.push(error.message);
      return Effect.succeed(Option.none<unknown>());
    }),
  );
  const config = Option.getOrNull(document);
  if (config !== null) {
    yield* loadAppConfigFile(configPath).pipe(Effect.catch((error) => Effect.sync(() => problems.push(error.message))));
  }
  if (syncProblem !== undefined) problems.push(syncProblem);

  const loadedConfig = yield* loadAppConfigFile(configPath).pipe(Effect.option);
  const accountIds = loadedConfig.pipe(
    Option.map((loaded) => loaded.accounts.map((account) => account.id)),
    Option.getOrElse((): string[] => []),
  );
  const slackIds = loadedConfig.pipe(
    Option.map((loaded) => loaded.slackAccounts.map((account) => account.id)),
    Option.getOrElse((): string[] => []),
  );
  const notionIds = loadedConfig.pipe(
    Option.map((loaded) => loaded.notionAccounts.map((account) => account.id)),
    Option.getOrElse((): string[] => []),
  );
  const microsoftIds = loadedConfig.pipe(
    Option.map((loaded) => loaded.microsoftAccounts.map((account) => account.id)),
    Option.getOrElse((): string[] => []),
  );
  const stored = new Set(yield* (yield* SecretVault).storedKeys);
  const store = yield* SecretStore;
  const secrets: Record<string, SecretStatus> = {};
  for (const key of [
    ...accountIds.map((id) => `github.${id}.token`),
    ...slackIds.flatMap((id) => [`slack.${id}.token`, `slack.${id}.cookie`]),
    ...notionIds.map(notionTokenKey),
    ...microsoftIds.map(microsoftRefreshTokenKey),
    ...LLM_SECRET_KEYS,
  ]) {
    secrets[key] = stored.has(key) ? "saved" : Option.isSome(yield* store.get(key)) ? "env" : "missing";
  }

  const encryptionAvailable = yield* Effect.promise(() => keychainCipher.isAvailable().catch(() => false));
  const now = yield* DateTime.now;
  const githubTokens: Record<string, GitHubTokenSummary> = {};
  for (const [accountId, info] of Object.entries(yield* (yield* tokenInfoStore).all)) {
    const expiryWarning = tokenExpiryWarning(info.expiresAt, now);
    githubTokens[accountId] = {
      ...info,
      missingRecommendedScopes: missingRecommendedScopes(info.scopes),
      ...(expiryWarning === undefined ? {} : { expiryWarning }),
    };
  }
  return { configPath, config, problems, secrets, encryptionAvailable, githubTokens } satisfies SettingsSnapshot;
});

function registerIpc() {
  ipcMain.handle(IPC_CHANNELS.board, () =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* BoardService).board;
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.move, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const { taskId, status } = yield* decodeMoveRequest(input);
        yield* (yield* BoardService).moveTask(taskId, status);
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.seen, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* BoardService).markSeen(yield* decodeTaskId(input));
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.taskDetail, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* BoardService).taskDetail(yield* decodeTaskId(input));
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, url: unknown) => {
    // renderer から来た URL をそのまま開かない理由: 任意の URL や file:// を開かせないため
    if (typeof url === "string" && isAllowedExternalUrl(url)) await shell.openExternal(url);
  });

  ipcMain.handle(IPC_CHANNELS.settings, () => runtime.runPromise(settingsSnapshot));
  ipcMain.handle(IPC_CHANNELS.saveConfig, async (_event, input: unknown) => {
    const outcome = await outcomeOf(saveAppConfigFile(configPath, input));
    if (outcome.ok) await restartSync();
    return outcome;
  });
  ipcMain.handle(IPC_CHANNELS.setSecret, async (_event, input: unknown) => {
    let detail: string | undefined;
    const outcome = await outcomeOf(
      Effect.gen(function* () {
        const { key, value } = yield* decodeSecretInput(input);
        const secret = Redacted.make(value);
        // GitHub のトークンは、同期に使えると確かめてから保存する（使えないトークンで同期を失敗させ続けないため）
        if (key.startsWith("github.")) {
          const http = yield* HttpClient.HttpClient;
          const info = yield* Effect.gen(function* () {
            return yield* verifyGitHubToken(yield* GitHubClient);
          }).pipe(Effect.provide(GitHubClientLive({ token: secret })), Effect.provideService(HttpClient.HttpClient, http));
          yield* (yield* SecretVault).set(key, secret);
          const accountId = accountOfTokenKey(key);
          yield* forgetRemoteRepositories(accountId);
          if (accountId !== undefined) {
            const { expiresAt, missingRecommendedScopes: _computedOnRead, ...rest } = info;
            yield* (yield* tokenInfoStore).save(accountId, {
              ...rest,
              ...(expiresAt === undefined ? {} : { expiresAt }),
              verifiedAt: DateTime.formatIso(yield* DateTime.now),
            });
          }
          detail = `${info.login} のトークンとして確認しました`;
          return;
        }
        yield* (yield* SecretVault).set(key, secret);
      }),
    );
    if (!outcome.ok) return outcome;
    await restartSync();
    return detail === undefined ? outcome : { ...outcome, detail };
  });
  ipcMain.handle(IPC_CHANNELS.removeSecret, async (_event, input: unknown) => {
    const outcome = await outcomeOf(
      Effect.gen(function* () {
        const key = yield* decodeSecretKey(input);
        yield* (yield* SecretVault).remove(key);
        const accountId = accountOfTokenKey(key);
        yield* forgetRemoteRepositories(accountId);
        if (accountId !== undefined) yield* (yield* tokenInfoStore).remove(accountId);
      }),
    );
    if (outcome.ok) await restartSync();
    return outcome;
  });
  ipcMain.handle(IPC_CHANNELS.previewFilter, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const request = yield* decodeFilterPreviewRequest(input);
        yield* decodeSecretKey(`github.${request.accountId}.token`);
        const cache = yield* Effect.promise(() => remoteRepositories);
        return yield* previewAccountFilter({ ...request, listRemote: Cache.get(cache, request.accountId) });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            error:
              error._tag === "InvalidRepositoryPatternError"
                ? `${error.pattern} は owner/repo か owner/* の形ではありません`
                : "message" in error
                  ? String(error.message)
                  : String(error),
          }),
        ),
      ),
    ),
  );
}

/** アカウントのトークンで GitHub のクライアントを作る（merge など、ユーザーが承認した操作のため） */
const githubClientFor = (accountId: string) =>
  Effect.gen(function* () {
    const token = yield* (yield* SecretStore).require(yield* decodeSecretKey(`github.${accountId}.token`));
    const http = yield* HttpClient.HttpClient;
    return yield* Effect.gen(function* () {
      return yield* GitHubClient;
    }).pipe(Effect.provide(GitHubClientLive({ token })), Effect.provideService(HttpClient.HttpClient, http));
  });

const errorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);

/** そのアカウントで Claude Code を使ってよいか（会社のコードを、許可していない LLM に送らないため） */
const claudeAllowedFor = (accountId: string) =>
  Effect.gen(function* () {
    const config = yield* loadAppConfigFile(configPath);
    const account = config.accounts.find((candidate) => candidate.id === accountId);
    return account !== undefined && (account.reviewDependencyPrs || account.planNextActions);
  });

/** 保存した設定と秘密情報で、Slack のクライアントを作る（承認した書き込みと、接続の確認のため） */
const slackClientFor = (accountId: string) =>
  Effect.gen(function* () {
    const config = yield* loadAppConfigFile(configPath);
    const account = config.slackAccounts.find((candidate) => candidate.id === accountId);
    if (account === undefined) return yield* new SlackRequestError({ message: `設定に Slack のワークスペース「${accountId}」がない` });
    const secrets = yield* SecretStore;
    const token = yield* secrets.require(`slack.${accountId}.token`);
    const cookie = yield* secrets.require(`slack.${accountId}.cookie`);
    const http = yield* HttpClient.HttpClient;
    return yield* Effect.gen(function* () {
      return yield* SlackClient;
    }).pipe(
      Effect.provide(SlackClientLive({ workspace: account.workspace, token, cookie, userAgent: account.userAgent })),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  });

/** 保存した設定と秘密情報で、Notion のクライアントを作る（接続の確認のため） */
const notionClientFor = (accountId: string) =>
  Effect.gen(function* () {
    const config = yield* loadAppConfigFile(configPath);
    const account = config.notionAccounts.find((candidate) => candidate.id === accountId);
    if (account === undefined) return yield* new NotionRequestError({ message: `設定に Notion のアカウント「${accountId}」がない` });
    const token = yield* (yield* SecretStore).require(notionTokenKey(accountId));
    const http = yield* HttpClient.HttpClient;
    return yield* Effect.gen(function* () {
      return yield* NotionClient;
    }).pipe(
      Effect.provide(NotionClientLive({ token, userId: account.userId, userAgent: account.userAgent, origin: account.origin })),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  });

/** 保存した設定で、Gmail のクライアントを作る（承認した書き込みのため。認証は gws に任せる） */
const gmailClientFor = (accountId: string) =>
  Effect.gen(function* () {
    const config = yield* loadAppConfigFile(configPath);
    if (!config.gmailAccounts.some((account) => account.id === accountId)) return yield* new GmailWriteError({ message: `設定に Gmail のアカウント「${accountId}」がない` });
    return yield* Effect.gen(function* () {
      return yield* GmailClient;
    }).pipe(Effect.provide(GmailClientLive.pipe(Layer.provide(Gws.layer))));
  });

/**
 * Task について Claude Code に質問してよいか。元の項目のアカウントで Claude Code で考えるのを有効にしていなければ断る
 * （会社のアカウントのデータを、許可していない LLM に送らないため。charter の前提と制約）。手で追加した Task は聞ける
 */
const questionAllowedFor = (taskId: number) =>
  Effect.gen(function* () {
    const config = yield* loadAppConfigFile(configPath);
    const db = yield* Database;
    const rows = yield* db
      .select({ source: sourceItems.source })
      .from(taskLinks)
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(eq(taskLinks.taskId, taskId))
      .pipe(Effect.orDie);
    return rows.every((row) => {
      const match = /^(github|slack|gmail):([^:]+)/.exec(row.source);
      if (match === null) return false;
      const [, kind, id] = match;
      if (kind === "github") return config.accounts.some((account) => account.id === id && (account.planNextActions || account.reviewDependencyPrs));
      if (kind === "slack") return config.slackAccounts.some((account) => account.id === id && account.planNextActions);
      return config.gmailAccounts.some((account) => account.id === id && account.planNextActions);
    });
  });

const MAX_MAIL_TEXT = 8000;

/** 質問に答えるときに渡す、元の項目の本文（今は Gmail のスレッドだけ） */
const questionContextFor = (taskId: number) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [thread] = yield* db
      .select({ source: sourceItems.source, externalId: sourceItems.externalId })
      .from(taskLinks)
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(and(eq(taskLinks.taskId, taskId), like(sourceItems.source, "gmail:%:threads")))
      .pipe(Effect.orDie);
    if (thread === undefined) return {};
    const accountId = /^gmail:([^:]+):threads$/.exec(thread.source)?.[1] ?? "";
    const messages = yield* (yield* gmailClientFor(accountId)).thread(thread.externalId);
    return {
      "mail.json": JSON.stringify(
        messages.map((message) => ({
          from: message.labelIds.includes("SENT") ? "me" : (message.headers.from ?? ""),
          at: new Date(message.receivedAt).toISOString(),
          subject: message.headers.subject ?? "",
          text: message.text.slice(0, MAX_MAIL_TEXT),
        })),
        null,
        2,
      ),
    };
  });

/** Claude Code に Task のことをさせるときの設定（読ませてよいもの・費用の上限） */
const claudeTaskOptionsOf = Effect.gen(function* () {
  const config = yield* loadAppConfigFile(configPath);
  // 読むことは広く許し、書き込みだけを止める（ADR-0013）。Google（gws）と GitHub（gh）は、そのアカウントで Claude Code で考えるのを
  // 有効にしているときに、どの Task の質問でも読ませる
  const google = config.gmailAccounts.some((account) => account.planNextActions);
  const github = config.accounts.some((account) => account.planNextActions || account.reviewDependencyPrs);
  const readAccess =
    google || github
      ? {
          gmail: google,
          github,
          denyRead: [
            secretsPath,
            tokenInfoPath,
            ...[dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`],
            configPath,
            app.getAppPath(),
            process.cwd(),
            agentWorkspaceRoot,
            // gh の認証（~/.config/gh）は、gh で読ませるときだけ読める場所に残す
            ...[".ssh", ".aws", ...(github ? [] : [".config/gh"]), ".npmrc", ".netrc", ".git-credentials", ".docker", ".kube", ".gnupg", ".claude", ".claude.json"].map((path) =>
              join(app.getPath("home"), path),
            ),
          ],
        }
      : undefined;
  return {
    model: DEPENDENCY_REVIEW_MODEL,
    maxBudgetUsd: DEPENDENCY_REVIEW_BUDGET_USD,
    extraContext: questionContextFor,
    ...(readAccess === undefined ? {} : { readAccess }),
  };
});
/** Claude Code を使ってよい Task なら、その設定。使わない設定のアカウントの Task なら undefined */
const claudeOptionsForTask = (taskId: number) =>
  questionAllowedFor(taskId).pipe(
    Effect.flatMap((allowed) => (allowed ? claudeTaskOptionsOf : Effect.succeed(undefined))),
    Effect.orElseSucceed(() => undefined),
  );

/** ルールの「何をする」を、Decisions でアプリの操作に読み取る（ADR-0014）。ラベルの名前は、文の中の名前と Gmail にあるラベルから選ばせる */
const interpretRuleActions = (then: string) =>
  Effect.gen(function* () {
    const config = yield* loadAppConfigFile(configPath);
    const account = config.gmailAccounts[0];
    if (account === undefined) return { ok: false as const, reason: "Gmail のアカウントを設定してから読み取ってください" };
    const classifier = yield* makeMailClassifier(account.resolvedLlmProfile);
    const existing = yield* gmailClientFor(account.id).pipe(
      Effect.flatMap((client) => client.labels),
      // システムのラベル（INBOX・CATEGORY_* など）は候補にしない
      Effect.map((labels) => labels.filter((label) => label.id.startsWith("Label_")).map((label) => label.name)),
      Effect.orElseSucceed(() => [] as string[]),
    );
    const candidates = [...new Set([...labelCandidatesOf(then), ...existing])].slice(0, MAX_LABEL_CANDIDATES);
    return actionsFromInterpretation(yield* classifier.interpretActions({ instruction: then, labels: candidates }));
  });
const MAX_LABEL_CANDIDATES = 30;

function registerTaskQuestions() {
  // 外部への書き込み。設定画面で確かめてから押したときだけ呼ばれる（ルールの範囲の書き込みで、ADR-0014）
  ipcMain.handle(IPC_CHANNELS.applyRuleToExisting, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(Schema.Struct({ ruleId: Schema.String.check(Schema.isNonEmpty()) }))(input);
        const config = yield* loadAppConfigFile(configPath);
        const rule = config.rules.find((candidate) => candidate.id === request.ruleId);
        if (rule === undefined) return { ok: false as const, reason: "保存したルールが見つかりません。設定を保存してから押してください" };
        const total = { applied: 0, alreadyApplied: 0, notMatched: 0 };
        for (const account of config.gmailAccounts) {
          const client = yield* gmailClientFor(account.id);
          const classifier = yield* makeMailClassifier(account.resolvedLlmProfile);
          const summary = yield* applyGmailRules(account.id, [rule], { includeExisting: rule.id }).pipe(
            Effect.provideService(GmailClient, client),
            Effect.provideService(MailClassifier, classifier),
          );
          total.applied += summary.applied;
          total.alreadyApplied += summary.alreadyApplied;
          total.notMatched += summary.notMatched;
        }
        return { ok: true as const, ...total };
      }).pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, reason: errorMessage(error) }))),
    ),
  );
  // 開く先を renderer から受け取らない理由: 乗っ取られた renderer に任意の URL を開かせないため。Task の手順に保存した https の開く先だけを開く
  ipcMain.handle(IPC_CHANNELS.openStepLink, async (_event, input: unknown) => {
    const link = await runtime.runPromise(
      Effect.gen(function* () {
        const request = yield* decodeStepRequest(input);
        const task = yield* (yield* TaskRepository).findTask(request.taskId);
        if (Option.isNone(task)) return undefined;
        return Option.match(decodePlan(task.value.nextActions), { onNone: () => undefined, onSome: (plan) => stepLinkOf(plan, request.stepId) });
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
    if (link !== undefined && URL.canParse(link.url) && new URL(link.url).protocol === "https:") await shell.openExternal(link.url);
  });
  ipcMain.handle(IPC_CHANNELS.interpretRule, (_event, input: unknown) =>
    runtime.runPromise(
      Schema.decodeUnknownEffect(Schema.Struct({ then: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(500)) }))(input).pipe(
        Effect.flatMap((request) => interpretRuleActions(request.then)),
        Effect.catch((error) => Effect.succeed({ ok: false as const, reason: errorMessage(error) })),
      ),
    ),
  );
  const TaskIdInput = Schema.Struct({ taskId: Schema.Int.check(Schema.isGreaterThan(0)) });
  ipcMain.handle(IPC_CHANNELS.taskQuestions, (_event, input: unknown) =>
    runtime.runPromise(
      Schema.decodeUnknownEffect(TaskIdInput)(input).pipe(
        Effect.flatMap((request) => listQuestions(request.taskId)),
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            question: row.question,
            status: row.status,
            answer: row.answer,
            sources: Array.isArray(row.sources) ? row.sources.filter((source): source is string => typeof source === "string") : [],
            error: row.error,
            askedAt: row.askedAt,
            answeredAt: row.answeredAt,
            suggestions: Array.isArray(row.suggestions) ? (row.suggestions as TaskSuggestion[]) : [],
          })),
        ),
        Effect.orElseSucceed(() => []),
      ),
    ),
  );
  const SuggestionInput = Schema.Struct({ questionId: Schema.Int.check(Schema.isGreaterThan(0)), index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) });
  ipcMain.handle(IPC_CHANNELS.acceptSuggestion, (_event, input: unknown) =>
    outcomeOf(Schema.decodeUnknownEffect(SuggestionInput)(input).pipe(Effect.flatMap((request) => acceptSuggestion(request.questionId, request.index)), Effect.asVoid)),
  );
  ipcMain.handle(IPC_CHANNELS.dismissSuggestion, (_event, input: unknown) =>
    outcomeOf(Schema.decodeUnknownEffect(SuggestionInput)(input).pipe(Effect.flatMap((request) => dismissSuggestion(request.questionId, request.index)))),
  );
  ipcMain.handle(IPC_CHANNELS.runStepWithClaude, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ taskId: Schema.Int.check(Schema.isGreaterThan(0)), stepId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)) }),
        )(input);
        const options = yield* claudeOptionsForTask(request.taskId);
        if (options === undefined) {
          return yield* new StepRunError({ message: "この Task の元の項目のアカウントでは Claude Code を使わない設定です。設定で Claude Code で考えるのを有効にしてから頼んでください" });
        }
        yield* startStepRun(request.taskId, request.stepId);
        runtime.runFork(runStep(request.taskId, request.stepId, options));
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.askTask, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(Schema.Struct({ taskId: Schema.Int.check(Schema.isGreaterThan(0)), question: Schema.String }))(input);
        if (!(yield* questionAllowedFor(request.taskId))) {
          return yield* new TaskQuestionError({ message: "この Task の元の項目のアカウントでは Claude Code を使わない設定です。設定で Claude Code で考えるのを有効にしてから質問してください" });
        }
        const id = yield* askQuestion(request.taskId, request.question);
        runtime.runFork(answerQuestion(id, yield* claudeTaskOptionsOf));
      }),
    ),
  );
}

function registerGmailActions() {
  const TaskIdInput = Schema.Struct({ taskId: Schema.Int.check(Schema.isGreaterThan(0)) });
  ipcMain.handle(IPC_CHANNELS.gmailMailTarget, (_event, input: unknown) =>
    runtime.runPromise(
      Schema.decodeUnknownEffect(TaskIdInput)(input).pipe(
        Effect.flatMap((request) => gmailMailTarget(request.taskId)),
        Effect.catch((error) => Effect.succeed({ error: errorMessage(error) })),
      ),
    ),
  );
  // 外部への書き込み。renderer で対象のメールと操作を見せ、ユーザーが押して承認したときだけ呼ばれる
  ipcMain.handle(IPC_CHANNELS.gmailRunStep, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ taskId: Schema.Int.check(Schema.isGreaterThan(0)), stepId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)), messageIds: Schema.Array(Schema.String) }),
        )(input);
        yield* gmailRunStep(request.taskId, request.stepId, request.messageIds, gmailClientFor);
      }),
    ),
  );
  // 外部への書き込み。renderer で一覧を見せて確認を出し、ユーザーが承認したメールだけを渡す
  ipcMain.handle(IPC_CHANNELS.gmailProcess, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ taskId: Schema.Int.check(Schema.isGreaterThan(0)), action: Schema.Literals(["archive", "trash"]), messageIds: Schema.Array(Schema.String) }),
        )(input);
        yield* gmailProcess(request.taskId, request.action, request.messageIds, gmailClientFor);
      }),
    ),
  );
}

function registerSlackSettings() {
  // 外部への書き込み。renderer で確認を出し、ユーザーが承認したときだけ呼ばれる
  ipcMain.handle(IPC_CHANNELS.slackAction, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ taskId: Schema.Int.check(Schema.isGreaterThan(0)), action: Schema.Literals(["complete", "remove"]) }),
        )(input);
        yield* slackWrite(request.taskId, request.action, slackClientFor);
      }),
    ),
  );
  // 外部への書き込みではない（自分のセッションを読み取るだけ）。読み取った値は暗号化して保存し、ログに出さない
  ipcMain.handle(IPC_CHANNELS.connectSlack, async (_event, input: unknown) => {
    const request = await runtime
      .runPromise(
        Schema.decodeUnknownEffect(
          Schema.Struct({ accountId: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)), workspace: Schema.String.check(Schema.isPattern(/^([a-z0-9][a-z0-9-]*(\.enterprise)?\.slack\.com)?$/)) }),
        )(input),
      )
      .catch(() => undefined);
    if (request === undefined) return { error: "アカウントの名前かワークスペースのドメインが正しくない" };
    const captured = await captureSlackSession(request.workspace).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    if (typeof captured === "string") return { error: captured };
    const outcome = await outcomeOf(
      Effect.gen(function* () {
        const vault = yield* SecretVault;
        yield* vault.set(`slack.${request.accountId}.token`, Redacted.make(captured.token));
        yield* vault.set(`slack.${request.accountId}.cookie`, Redacted.make(captured.cookie));
        const document = yield* readAppConfigDocument(configPath);
        yield* saveAppConfigFile(
          configPath,
          withSlackSession(Option.getOrElse(document, () => ({})), { id: request.accountId, workspace: captured.workspace, userAgent: captured.userAgent }),
        );
      }),
    );
    if (!outcome.ok) return { error: outcome.message };
    await restartSync();
    return { team: captured.team, workspace: captured.workspace };
  });

  ipcMain.handle(IPC_CHANNELS.testSlack, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const accountId = yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)))(input);
        const me = yield* (yield* slackClientFor(accountId)).authTest;
        return { user: me.user, team: me.team };
      }).pipe(Effect.catch((error) => Effect.succeed({ error: errorMessage(error) }))),
    ),
  );
}

const pendingMicrosoftSignIns = new Map<string, { app: MicrosoftApp; code: DeviceCode }>();

const microsoftAccountFor = (accountId: string) =>
  Effect.gen(function* () {
    const config = yield* loadAppConfigFile(configPath);
    const account = config.microsoftAccounts.find((candidate) => candidate.id === accountId);
    if (account === undefined) return yield* Effect.fail(new Error(`保存した設定に Microsoft のアカウント「${accountId}」がない。先に設定を保存してください`));
    return account;
  });

function registerMicrosoftSettings() {
  const AccountIdInput = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/));
  // 外部への書き込みではない（自分のサインインを済ませるだけ）。コードとトークンはログに出さない
  ipcMain.handle(IPC_CHANNELS.startMicrosoftSignIn, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const accountId = yield* Schema.decodeUnknownEffect(AccountIdInput)(input);
        const app = microsoftAppOf(yield* microsoftAccountFor(accountId));
        const code = yield* requestDeviceCode(app);
        pendingMicrosoftSignIns.set(accountId, { app, code });
        if (isAllowedExternalUrl(code.verificationUri)) void shell.openExternal(code.verificationUri);
        return { userCode: code.userCode, verificationUri: code.verificationUri, expiresInSeconds: code.expiresInSeconds };
      }).pipe(Effect.catch((error) => Effect.succeed({ error: errorMessage(error) }))),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.finishMicrosoftSignIn, (_event, input: unknown) =>
    runtime
      .runPromise(
        Effect.gen(function* () {
          const accountId = yield* Schema.decodeUnknownEffect(AccountIdInput)(input);
          const pending = pendingMicrosoftSignIns.get(accountId);
          if (pending === undefined) return { error: "サインインを始めていない" };
          const tokens = yield* pollDeviceToken(pending.app, pending.code).pipe(Effect.ensuring(Effect.sync(() => pendingMicrosoftSignIns.delete(accountId))));
          yield* (yield* SecretVault).set(microsoftRefreshTokenKey(accountId), tokens.refreshToken);
          const me = (yield* (yield* graphClientFor(yield* microsoftAccountFor(accountId))).get("/me", { query: { $select: "displayName,mail" } })) as { displayName?: string; mail?: string };
          return { user: me.displayName ?? me.mail ?? "" };
        }).pipe(Effect.catch((error) => Effect.succeed({ error: errorMessage(error) }))),
      )
      .then(async (result) => {
        if (!("error" in result)) await restartSync();
        return result;
      }),
  );

  ipcMain.handle(IPC_CHANNELS.testMicrosoft, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const accountId = yield* Schema.decodeUnknownEffect(AccountIdInput)(input);
        const me = (yield* (yield* graphClientFor(yield* microsoftAccountFor(accountId))).get("/me", { query: { $select: "displayName,mail" } })) as { displayName?: string; mail?: string };
        return { user: me.displayName ?? me.mail ?? "" };
      }).pipe(Effect.catch((error) => Effect.succeed({ error: errorMessage(error) }))),
    ),
  );
}

function registerNotionSettings() {
  // 外部への書き込みではない（自分のセッションを読み取るだけ）。読み取った値は暗号化して保存し、ログに出さない
  ipcMain.handle(IPC_CHANNELS.connectNotion, async (_event, input: unknown) => {
    const request = await runtime
      .runPromise(Schema.decodeUnknownEffect(Schema.Struct({ accountId: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)) }))(input))
      .catch(() => undefined);
    if (request === undefined) return { error: "アカウントの名前が正しくない" };
    const captured = await captureNotionSession().catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    if (typeof captured === "string") return { error: captured };
    const outcome = await outcomeOf(
      Effect.gen(function* () {
        yield* (yield* SecretVault).set(notionTokenKey(request.accountId), Redacted.make(captured.token));
        const document = yield* readAppConfigDocument(configPath);
        yield* saveAppConfigFile(
          configPath,
          withNotionSession(Option.getOrElse(document, () => ({})), { id: request.accountId, userId: captured.userId, userAgent: captured.userAgent, origin: captured.origin }),
        );
      }),
    );
    if (!outcome.ok) return { error: outcome.message };
    await restartSync();
    return { user: captured.userId };
  });

  ipcMain.handle(IPC_CHANNELS.testNotion, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const accountId = yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)))(input);
        const me = yield* (yield* notionClientFor(accountId)).me;
        return { user: me.name, spaces: me.spaces.map((space) => space.name) };
      }).pipe(Effect.catch((error) => Effect.succeed({ error: errorMessage(error) }))),
    ),
  );
}

const ScheduleInput = Schema.Struct({
  kind: Schema.Literal("monthly"),
  day: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  leadDays: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 27 })),
});
const TextInput = Schema.String.check(Schema.isMaxLength(2000));

function registerTasksAndRecurring() {
  ipcMain.handle(IPC_CHANNELS.addTask, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(Schema.Struct({ title: TextInput, brief: Schema.optional(TextInput) }))(input);
        yield* (yield* BoardService).addTask(request.brief === undefined ? { title: request.title } : { title: request.title, brief: request.brief });
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.recurringList, () =>
    runtime.runPromise(
      listRecurringTasks.pipe(
        Effect.map((rules) =>
          rules.map((rule) => ({ id: rule.id, title: rule.title, note: rule.note, schedule: rule.schedule, active: rule.active, lastPeriod: rule.lastPeriod })),
        ),
      ),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.recurringGhosts, () => runtime.runPromise(localToday.pipe(Effect.flatMap(upcomingRecurringTasks))));
  ipcMain.handle(IPC_CHANNELS.recurringCreateNow, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const ruleId = yield* Schema.decodeUnknownEffect(Schema.Int.check(Schema.isGreaterThan(0)))(input);
        yield* createRecurringNow(ruleId, yield* localToday);
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.recurringCreate, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ title: TextInput, note: TextInput, schedule: ScheduleInput, includeCurrent: Schema.Boolean }),
        )(input);
        yield* createRecurringTask(request, yield* localToday);
        yield* runRecurringTasks(yield* localToday);
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.recurringFromTask, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ taskId: Schema.Int.check(Schema.isGreaterThan(0)), title: Schema.optional(TextInput), note: TextInput, schedule: ScheduleInput, includeCurrent: Schema.Boolean }),
        )(input);
        yield* createRecurringFromTask(request.taskId, request, yield* localToday);
        yield* runRecurringTasks(yield* localToday);
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.recurringUpdate, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            id: Schema.Int.check(Schema.isGreaterThan(0)),
            title: Schema.optional(TextInput),
            note: Schema.optional(TextInput),
            schedule: Schema.optional(ScheduleInput),
            active: Schema.optional(Schema.Boolean),
          }),
        )(input);
        if (request.active !== undefined) yield* updateRecurringActive(request.id, request.active);
        yield* updateRecurringTask(request.id, {
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.note === undefined ? {} : { note: request.note }),
          ...(request.schedule === undefined ? {} : { schedule: request.schedule }),
        });
      }),
    ),
  );
}

function registerReplan() {
  ipcMain.handle(IPC_CHANNELS.replanNextActions, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        // 前の形（Task の id だけ）も受け付ける。request はユーザーの希望（こうしたい）
        const { taskId, request } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ taskId: Schema.Int.check(Schema.isGreaterThan(0)), request: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))) }),
        )(typeof input === "number" ? { taskId: input } : input);
        const detail = yield* (yield* BoardService).taskDetail(taskId);
        // 次にやることを考える処理は、AI に考えさせる設定のアカウントでしか動かない（会社の情報を許可していない LLM に送らないため）
        const config = yield* loadAppConfigFile(configPath);
        const accountIds = detail.items.filter((item) => item.role === "tracks").map((item) => /^(?:github|slack|gmail):([^:]+)/.exec(item.source)?.[1]);
        const planning = [...config.accounts, ...config.slackAccounts, ...config.gmailAccounts].filter((account) => account.planNextActions).map((account) => account.id);
        const allowed = accountIds.length > 0 && accountIds.every((id) => id !== undefined && planning.includes(id));
        if (!allowed) return yield* new GitHubRequestError({ message: "このアカウントでは、次にやることを AI に考えさせない設定です" });
        yield* requestReplan(taskId, request);
      }),
    ),
  );
}

// 修正はコマンドも使うので、調査より時間と予算がかかる
const PULL_FIX_BUDGET_USD = 5;

function registerPullRequestFix() {
  ipcMain.handle(IPC_CHANNELS.fixPullRequest, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const taskId = yield* decodeTaskId(input);
        const target = yield* conflictTarget(taskId);
        if (!(yield* claudeAllowedFor(target.accountId))) {
          return yield* new GitHubRequestError({ message: "このアカウントでは Claude Code を使わない設定です。設定画面で AI の調査を有効にしてから直してください" });
        }
        const runId = yield* startPullRequestFix(taskId);
        runtime.runFork(
          finishPullRequestFix(runId, {
            model: DEPENDENCY_REVIEW_MODEL,
            maxBudgetUsd: PULL_FIX_BUDGET_USD,
            home: app.getPath("home"),
            // アプリの秘密情報・DB・設定と、アプリのソース（.env.local がある）は読ませない。
            // userData を丸ごと塞がない理由: Claude Code の作業場所（agent-workspaces）もその中にあるため
            denyRead: [
              secretsPath,
              tokenInfoPath,
              ...[dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`],
              configPath,
              app.getAppPath(),
              process.cwd(),
              agentWorkspaceRoot,
            ],
          }),
        );
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.pullRequestFix, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const latest = yield* latestPullRequestFix(yield* decodeTaskId(input));
        if (Option.isNone(latest)) return { error: "Claude Code が修正した記録がない" };
        const { cwd: _cwd, ...view } = latest.value.result;
        return view;
      }).pipe(Effect.catch((error) => Effect.succeed({ error: errorMessage(error) }))),
    ),
  );
  // 外部への書き込み。renderer で差分を見せ、ユーザーが承認したときだけ呼ばれる
  ipcMain.handle(IPC_CHANNELS.pushPullRequestFix, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* decodeConflictPushRequest(input);
        yield* pushPullRequestFix(request.taskId, request.commitSha, (accountId) =>
          Effect.gen(function* () {
            return Redacted.value(yield* (yield* SecretStore).require(yield* decodeSecretKey(`github.${accountId}.token`)));
          }),
        );
      }),
    ),
  );
}

function registerConflictResolution() {
  ipcMain.handle(IPC_CHANNELS.resolveConflicts, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const taskId = yield* decodeTaskId(input);
        const target = yield* conflictTarget(taskId);
        if (!(yield* claudeAllowedFor(target.accountId))) {
          return yield* new GitHubRequestError({
            message: "このアカウントでは Claude Code を使わない設定です。設定画面で AI の調査を有効にしてから直してください",
          });
        }
        const runId = yield* startConflictResolution(taskId);
        runtime.runFork(finishConflictResolution(runId, { model: DEPENDENCY_REVIEW_MODEL, maxBudgetUsd: DEPENDENCY_REVIEW_BUDGET_USD }));
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.conflictResolution, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const latest = yield* latestConflictResolution(yield* decodeTaskId(input));
        if (Option.isNone(latest)) return { error: "コンフリクトを直した記録がない" };
        const { cwd: _cwd, conflicted: _conflicted, ...view } = latest.value.result;
        return view;
      }).pipe(Effect.catch((error) => Effect.succeed({ error: errorMessage(error) }))),
    ),
  );
  // 外部への書き込み。renderer で差分を見せ、ユーザーが承認したときだけ呼ばれる
  ipcMain.handle(IPC_CHANNELS.pushConflictResolution, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* decodeConflictPushRequest(input);
        yield* pushConflictResolution(request.taskId, request.commitSha, (accountId) =>
          Effect.gen(function* () {
            // push のときだけ平文に戻し、git の環境変数にだけ渡す
            return Redacted.value(yield* (yield* SecretStore).require(yield* decodeSecretKey(`github.${accountId}.token`)));
          }),
        );
      }),
    ),
  );
}

function registerMerge() {
  ipcMain.handle(IPC_CHANNELS.completeStep, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* decodeStepRequest(input);
        yield* (yield* BoardService).completeStep(request.taskId, request.stepId);
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.reopenStep, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* decodeStepRequest(input);
        yield* (yield* BoardService).reopenStep(request.taskId, request.stepId);
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.chooseOption, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* decodeStepRequest(input);
        if (request.optionKey === undefined) return;
        yield* (yield* BoardService).chooseOption(request.taskId, request.stepId, request.optionKey);
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.requestReview, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        yield* requestDependencyReview(yield* decodeTaskId(input));
      }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.mergePlan, (_event, input: unknown) =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* mergePlan(yield* decodeTaskId(input), githubClientFor);
      }).pipe(Effect.catch((error) => Effect.succeed({ error: errorMessage(error) }))),
    ),
  );
  // 外部への書き込み。renderer で確認を出し、ユーザーが承認した方法と commit だけを受け取って実行する。
  // 始められたかだけを返し、merge は裏で進める（Task は処理中のレーンに移り、終われば完了か元のレーンに戻る）
  ipcMain.handle(IPC_CHANNELS.merge, (_event, input: unknown) =>
    outcomeOf(
      Effect.gen(function* () {
        const request = yield* decodeMergeRequest(input);
        const approved = { method: request.method, sha: request.sha };
        const runId = yield* startMerge(request.taskId, approved, githubClientFor);
        runtime.runFork(finishMerge(runId, approved, githubClientFor));
      }),
    ),
  );
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    title: "live-todo",
    backgroundColor: "#141826",
    // 確認用の起動では透明にし、フォーカスを奪わずに表示する。隠したまま（show: false）だと
    // macOS ではページの読み込みが進まないため
    show: !headless,
    opacity: headless ? 0 : 1,
    focusable: !headless,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !headless,
    },
  });
  // 外部のページは openExternal（URL を検証する）からだけ開かせる
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (headless) window.showInactive();

  if (screenshotPath !== undefined) {
    window.webContents.once("did-finish-load", () => {
      void (async () => {
        const { setTimeout: wait } = await import("node:timers/promises");
        await wait(2500);
        if (screenshotScript !== undefined) {
          await window.webContents.executeJavaScript(screenshotScript);
          await wait(6000);
        }
        const image = await window.webContents.capturePage();
        const { writeFile } = await import("node:fs/promises");
        await writeFile(screenshotPath, image.toPNG());
        console.log(`live-todo: 画面を保存した ${screenshotPath}`);
        app.quit();
      })();
    });
  }

  if (smokeTest) {
    window.webContents.once("did-finish-load", () => {
      void window.webContents.executeJavaScript("typeof window.liveTodo").then((exposed) => {
        console.log(`live-todo: 画面を読み込めた（preload の API: ${exposed}）`);
        setTimeout(() => app.quit(), 500);
      });
    });
  }

  // 開発用: LIVE_TODO_VIEW=settings で設定画面を開いた状態で起動する
  const hash = process.env["LIVE_TODO_VIEW"] === "settings" ? "settings" : undefined;
  const devServer = process.env["ELECTRON_RENDERER_URL"];
  if (devServer !== undefined) void window.loadURL(hash === undefined ? devServer : `${devServer}#${hash}`);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"), hash === undefined ? {} : { hash });
}

void app.whenReady().then(() => {
  if (headless) app.dock?.hide();
  registerIpc();
  registerMerge();
  registerConflictResolution();
  registerPullRequestFix();
  registerReplan();
  registerTasksAndRecurring();
  registerSlackSettings();
  registerNotionSettings();
  registerMicrosoftSettings();
  registerGmailActions();
  registerTaskQuestions();
  createWindow();
  if (smokeTest || screenshotPath !== undefined) return;
  void (async () => {
    // 配る版は Finder から起動され、PATH が狭くて gws・claude・gh を見つけられないので、同期の前にログインシェルの PATH を読む
    if (app.isPackaged && process.platform === "darwin") {
      const path = await runtime.runPromise(loginShellPath(process.env["SHELL"] ?? "/bin/zsh"));
      if (Option.isSome(path)) process.env["PATH"] = mergePath(process.env["PATH"], path.value);
    }
    await restartSync();
  })();
});

app.on("window-all-closed", () => {
  // macOS ではウィンドウを閉じても同期を続ける（Dock から開き直せる）
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("will-quit", () => {
  void runtime.dispose();
});
