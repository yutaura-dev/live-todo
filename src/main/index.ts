import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cache, Cause, DateTime, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { loadAppConfigFile, readAppConfigDocument, saveAppConfigFile } from "../app/config/app-config.js";
import { dismissTasksOutsideFilter } from "../app/filter-cleanup.js";
import { makeGitHubJobs } from "../app/github-jobs.js";
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
import { makeTokenInfoStore } from "../app/settings/token-info-store.js";
import { missingRecommendedScopes, tokenExpiryWarning, verifyGitHubToken } from "../app/settings/verify-github-token.js";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode } from "../core/agent/claude-code.js";
import { backfillNextActions, recoverInterruptedAgentRuns, requestDependencyReview, runDependencyReviews } from "../core/agent/dependency-triage.js";
import { runNextActionPlanning } from "../core/agent/next-action-runner.js";
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

  yield* backfillNextActions;
  yield* applyConflictPlans;
  yield* completeFinishedPlans;
  yield* upgradeMergeSteps;
  const recovered = yield* recoverInterruptedAgentRuns;
  if (recovered > 0) yield* Effect.log(`途中で止まった AI の調査を ${recovered} 件戻した`);
  const reviewSources = config.accounts
    .filter((account) => account.reviewDependencyPrs)
    .flatMap((account) => [`github:${account.id}`, `github:${account.id}:watch`]);
  const planSources = config.accounts
    .filter((account) => account.planNextActions)
    .flatMap((account) => [`github:${account.id}`, `github:${account.id}:watch`]);
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
  yield* Effect.log(`同期を始める: ${[...jobs, ...agentJobs, conflictPlanJob].map((job) => job.name).join(", ")}`);
  return yield* Effect.all([runJobs(jobs), runJobs(agentJobs), runJobs([conflictPlanJob])], { concurrency: 3, discard: true });
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

  const accountIds = (yield* loadAppConfigFile(configPath).pipe(Effect.option)).pipe(
    Option.map((loaded) => loaded.accounts.map((account) => account.id)),
    Option.getOrElse((): string[] => []),
  );
  const stored = new Set(yield* (yield* SecretVault).storedKeys);
  const store = yield* SecretStore;
  const secrets: Record<string, SecretStatus> = {};
  for (const key of [...accountIds.map((id) => `github.${id}.token`), ...LLM_SECRET_KEYS]) {
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
  createWindow();
  if (!smokeTest && screenshotPath === undefined) void restartSync();
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
