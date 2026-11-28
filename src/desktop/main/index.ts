import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { Effect, ManagedRuntime } from "effect";
import { Duration, Schedule } from "effect";
import { StoreDatabase } from "../../store/database.js";
import { CHANNELS } from "../shared/api.js";
import { handleCommand, handleQuery } from "./ipc.js";
import { desktopLayer } from "./layer.js";
import { Calendar } from "./prioritizer.js";
import { TaskIds, TaskService } from "./task-service.js";

// 今のアプリ（live-todo.db）とは別のファイルにする（作り直しの間、両方を並べて動かせるように）
const DATABASE_FILE = "live-todo-store.db";

const runtime = ManagedRuntime.make(
  desktopLayer({
    database: StoreDatabase.layer({
      filename: join(app.getPath("userData"), DATABASE_FILE),
      // app.getAppPath() は dev ではビルド先（out-desktop/main）を返すので、ビルドした main から見た位置で指す
      migrationsFolder: join(import.meta.dirname, "../../drizzle-store"),
    }),
    calendar: Calendar.system,
    ids: TaskIds.random,
  }),
);

// 日が変わったら期日までの日数が変わるので、起動したときと 1 時間おきに優先度を決め直す（変わらなければ何も起きない）
const REFRESH_EVERY = Duration.hours(1);

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
  await runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* TaskService;
      yield* service.onChanged(() => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(CHANNELS.changed)));
    }),
  );
  runtime.runFork(
    Effect.gen(function* () {
      yield* (yield* TaskService).refreshAll();
    }).pipe(Effect.repeat(Schedule.spaced(REFRESH_EVERY))),
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => void runtime.dispose());
