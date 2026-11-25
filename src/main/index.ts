import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cause, Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { loadAppConfigFile } from "../app/config/app-config.js";
import { makeGitHubJobs } from "../app/github-jobs.js";
import { BoardService } from "../core/board/board-service.js";
import { EnvSecretStore } from "../core/config/secret-store.js";
import { Database, databaseMigrationsFrom } from "../core/db/database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { runJobs } from "../core/sync/scheduler.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { decodeMoveRequest, decodeTaskId, IPC_CHANNELS, isAllowedExternalUrl } from "./ipc.js";

// 開発中はリポジトリの config.json と live-todo.db を使い、配布したアプリではユーザーごとのデータの置き場所を使う
const dataPath = (name: string) => (app.isPackaged ? join(app.getPath("userData"), name) : join(process.cwd(), name));
const dbPath = process.env["LIVE_TODO_DB"] ?? dataPath("live-todo.db");
const configPath = process.env["LIVE_TODO_CONFIG"] ?? dataPath("config.json");
const smokeTest = process.env["LIVE_TODO_SMOKE"] === "1";
// 開発用: 指定したパスに画面の PNG を保存して終了する（見た目を確かめるため）
const screenshotPath = process.env["LIVE_TODO_SCREENSHOT"];

const AppLayer = Layer.mergeAll(BoardService.layer.pipe(Layer.provideMerge(TaskRepository.layer)), SourceItemRepository.layer).pipe(
  Layer.provideMerge(databaseMigrationsFrom(join(app.getAppPath(), "drizzle"))),
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(SqliteClient.layer({ filename: dbPath })),
  Layer.provideMerge(Layer.mergeAll(EnvSecretStore, FetchHttpClient.layer, NodeFileSystem.layer)),
);
const runtime = ManagedRuntime.make(AppLayer);

const startSync = Effect.gen(function* () {
  const config = yield* loadAppConfigFile(configPath);
  const jobs = (yield* Effect.forEach(config.accounts, makeGitHubJobs)).flat();
  yield* Effect.log(`同期を始める: ${jobs.map((job) => job.name).join(", ")}`);
  return yield* runJobs(jobs);
}).pipe(
  // 設定やトークンがなくても画面は開けるようにする（同期だけが止まる）
  Effect.catchCause((cause) => Effect.logError("同期を始められない").pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) }))),
);

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
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    title: "live-todo",
    backgroundColor: "#E8EDF1",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // 外部のページは openExternal（URL を検証する）からだけ開かせる
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (screenshotPath !== undefined) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        void window.webContents.capturePage().then(async (image) => {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(screenshotPath, image.toPNG());
          console.log(`live-todo: 画面を保存した ${screenshotPath}`);
          app.quit();
        });
      }, 2500);
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

  const devServer = process.env["ELECTRON_RENDERER_URL"];
  if (devServer !== undefined) void window.loadURL(devServer);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

void app.whenReady().then(() => {
  registerIpc();
  createWindow();
  if (!smokeTest && screenshotPath === undefined) runtime.runFork(startSync);
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
