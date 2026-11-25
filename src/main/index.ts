import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cause, DateTime, Effect, Fiber, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { loadAppConfigFile, readAppConfigDocument, saveAppConfigFile } from "../app/config/app-config.js";
import { makeGitHubJobs } from "../app/github-jobs.js";
import { previewAccountFilter } from "../app/settings/filter-preview.js";
import { makeTokenInfoStore } from "../app/settings/token-info-store.js";
import { tokenExpiryWarning, verifyGitHubToken } from "../app/settings/verify-github-token.js";
import { BoardService } from "../core/board/board-service.js";
import { encryptedFileSecretStore, type SecretCipher, SecretVault } from "../core/config/encrypted-secret-store.js";
import { SecretStore } from "../core/config/secret-store.js";
import { Database, databaseMigrationsFrom } from "../core/db/database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { runJobs } from "../core/sync/scheduler.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { GitHubClient, GitHubRequestError } from "../sources/github/github-adapter.js";
import { GitHubClientLive } from "../sources/github/github-client-live.js";
import type { GitHubTokenSummary, Outcome, SecretStatus, SettingsSnapshot } from "../shared/api.js";
import {
  decodeFilterPreviewRequest,
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
  Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, NodeFileSystem.layer)),
);
const runtime = ManagedRuntime.make(AppLayer);
// 使うたびに作る理由: 中身はファイルの読み書きだけで、書くのはトークンを保存・削除したときに限られるため
const tokenInfoStore = makeTokenInfoStore(tokenInfoPath);
const accountOfTokenKey = (key: string) => /^github\.(.+)\.token$/.exec(key)?.[1];

let syncFiber: Fiber.Fiber<unknown, unknown> | undefined;
let syncProblem: string | undefined;

const startSync = Effect.gen(function* () {
  const config = yield* loadAppConfigFile(configPath);
  const jobs = (yield* Effect.forEach(config.accounts, makeGitHubJobs)).flat();
  syncProblem = undefined;
  yield* Effect.log(`同期を始める: ${jobs.map((job) => job.name).join(", ")}`);
  return yield* runJobs(jobs);
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
    githubTokens[accountId] = { ...info, ...(expiryWarning === undefined ? {} : { expiryWarning }) };
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
          if (accountId !== undefined) {
            const { expiresAt, ...rest } = info;
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
        const tokenKey = yield* decodeSecretKey(`github.${request.accountId}.token`);
        const token = yield* (yield* SecretStore).get(tokenKey);
        const http = yield* HttpClient.HttpClient;
        // 同期とは別のクライアントで取る理由: 設定を保存する前のフィルタで試すので、同期中のジョブとは
        // 組み立てが別になる。一覧の取得は数ページで終わるので、キューが分かれても集中にはならない。
        const listRemote = Option.match(token, {
          onNone: () => Effect.fail(new GitHubRequestError({ message: "このアカウントのトークンが登録されていない" })),
          onSome: (value) =>
            Effect.gen(function* () {
              return yield* (yield* GitHubClient).listMyRepositories;
            }).pipe(Effect.provide(GitHubClientLive({ token: value })), Effect.provideService(HttpClient.HttpClient, http)),
        });
        return yield* previewAccountFilter({ ...request, listRemote });
      }).pipe(Effect.catch((error) => Effect.succeed({ error: "message" in error ? String(error.message) : String(error) }))),
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
