import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Duration, Schedule } from "effect";
import { StoreDatabase } from "../../store/database.js";
import { CHANNELS } from "../shared/api.js";
import { liveConnector } from "./ai/connector-live.js";
import { handleAiCommand, handleCommand, handleInbox, handleQuery, syncOnce } from "./ipc.js";
import { SourceGateway } from "./sources/gateway.js";
import { WriteProvider } from "./writes/write-provider.js";
import { WriteService } from "./writes/write-service.js";
import { AgentService } from "./agent/agent-service.js";
import { ClaudeCodeRunner } from "./agent/claude-code-runner.js";
import { desktopLayer } from "./layer.js";
import { Calendar } from "./prioritizer.js";
import { TaskIds, TaskService } from "./task-service.js";

// 今のアプリ（live-todo.db）とは別のファイルにする（作り直しの間、両方を並べて動かせるように）
const DATABASE_FILE = "live-todo-store.db";

// API キーは .env.local に置く（ai-settings.spec）。dev ではリポジトリの直下にある
const ENV_LOCAL = join(import.meta.dirname, "../../.env.local");
if (existsSync(ENV_LOCAL)) process.loadEnvFile(ENV_LOCAL);

const commandSucceeds = (command: string, args: ReadonlyArray<string>) =>
  Effect.callback<boolean>((resume) => {
    execFile(command, [...args], { timeout: 10_000 }, (error) => resume(Effect.succeed(error === null)));
  });

const runtime = ManagedRuntime.make(
  desktopLayer({
    database: StoreDatabase.layer({
      filename: join(app.getPath("userData"), DATABASE_FILE),
      // app.getAppPath() は dev ではビルド先（out-desktop/main）を返すので、ビルドした main から見た位置で指す
      migrationsFolder: join(import.meta.dirname, "../../drizzle-store"),
    }),
    calendar: Calendar.system,
    ids: TaskIds.random,
    connector: liveConnector({ env: process.env, commandSucceeds }),
    gateway: SourceGateway.live(process.env),
    writer: (stores) => WriteProvider.live(process.env).pipe(Layer.provide(stores)),
    agent: ClaudeCodeRunner.live({
      env: process.env,
      // Claude Code の会話は作業場所に結び付くので、Task ごとに決まった場所で動かす
      workRoot: join(app.getPath("userData"), "agent-work"),
      newSessionId: randomUUID,
      ensureDir: (path) => void mkdirSync(path, { recursive: true }),
      spawn: (command, args, options) => spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"] }),
    }),
  }),
);

// 日が変わったら期日までの日数が変わるので、起動したときと 1 時間おきに優先度を決め直す（変わらなければ何も起きない）
const REFRESH_EVERY = Duration.hours(1);
const SYNC_TICK = Duration.seconds(30);

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // renderer の中からほかのページへ移らせない（外のページに preload の API を渡さないため）
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return window;
}

app.whenReady().then(async () => {
  ipcMain.handle(CHANNELS.command, (_event, raw: unknown) => runtime.runPromise(handleCommand(raw)));
  ipcMain.handle(CHANNELS.query, (_event, raw: unknown) => runtime.runPromise(handleQuery(raw)));
  ipcMain.handle(CHANNELS.ai, (_event, raw: unknown) => runtime.runPromise(handleAiCommand(raw)));
  ipcMain.handle(CHANNELS.inbox, (_event, raw: unknown) => runtime.runPromise(handleInbox(raw)));
  await runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* TaskService;
      const broadcast = () => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(CHANNELS.changed));
      yield* service.onChanged(broadcast);
      // Claude Code の答え・途中経過はあとから届くので、届いたら画面に知らせる
      yield* (yield* AgentService).onChanged(broadcast);
    }),
  );
  // 書き込み中のまま止まっていた書き込みを、やり直さずに確かめる（二重に書き込まないため。write.spec）
  await runtime.runPromise(
    Effect.gen(function* () {
      yield* (yield* WriteService).recover();
      // やっているまま止まっていた Claude Code の作業は、アプリを閉じたので止まったにする（agent-run.spec）
      yield* (yield* AgentService).recover();
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("書き込みの後始末ができなかった", cause))),
  );
  runtime.runFork(
    Effect.gen(function* () {
      yield* (yield* TaskService).refreshAll();
    }).pipe(Effect.repeat(Schedule.spaced(REFRESH_EVERY))),
  );
  // 取り込みは 30 秒おきに見に行く（アカウントごとの間隔と失敗のときの延ばし方は SyncRunner が決める）
  runtime.runFork(syncOnce.pipe(Effect.catchCause((cause) => Effect.logWarning("取り込めなかった", cause)), Effect.repeat(Schedule.spaced(SYNC_TICK))));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => void runtime.dispose());
