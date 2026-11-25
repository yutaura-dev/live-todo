import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cause, Config, Effect, Exit, Layer, References } from "effect";
import { FetchHttpClient } from "effect/http";
import { EnvSecretStore } from "../core/config/secret-store.js";
import { Database, DatabaseMigrations } from "../core/db/database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { runJobsOnce } from "../core/sync/run-once.js";
import { runJobs } from "../core/sync/scheduler.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { loadAppConfigFile } from "./config/app-config.js";
import { makeGitHubJobs } from "./github-jobs.js";

const mode = process.argv[2] === "watch" ? "watch" : "once";

const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const filename = yield* Config.String("LIVE_TODO_DB").pipe(Config.withDefault("./live-todo.db"));
    return Layer.mergeAll(SourceItemRepository.layer, TaskRepository.layer).pipe(
      Layer.provideMerge(DatabaseMigrations),
      Layer.provideMerge(Database.layer),
      Layer.provideMerge(SqliteClient.layer({ filename })),
    );
  }),
);

const printTasks = Effect.gen(function* () {
  const tasks = yield* (yield* TaskRepository).listTasks;
  yield* Effect.log(`Task: ${tasks.length} 件`);
  for (const task of tasks) {
    const mark = task.unreadChanges > 0 ? " ●" : "";
    console.log(`  [${task.status}]${mark} ${task.title}`);
  }
});

// 判定の理由など debug のログを見たいときは LIVE_TODO_LOG_LEVEL=Debug を付けて実行する
const logLevel = Config.LogLevel("LIVE_TODO_LOG_LEVEL").pipe(Config.withDefault("Info"));

const program = Effect.gen(function* () {
  const configPath = yield* Config.String("LIVE_TODO_CONFIG").pipe(Config.withDefault("./config.json"));
  const config = yield* loadAppConfigFile(configPath);
  const jobs = (yield* Effect.forEach(config.accounts, makeGitHubJobs)).flat();
  yield* Effect.log(`ジョブ: ${jobs.map((job) => job.name).join(", ")}`);

  if (mode === "watch") {
    return yield* runJobs(jobs);
  }

  for (const result of yield* runJobsOnce(jobs)) {
    if (Exit.isSuccess(result.exit)) {
      yield* Effect.log(`${result.name}: ${JSON.stringify(result.exit.value)}`);
    } else {
      yield* Effect.logError(`${result.name}: 失敗`).pipe(Effect.annotateLogs({ cause: Cause.pretty(result.exit.cause) }));
    }
  }
  yield* printTasks;
}).pipe(
  Effect.provide(DatabaseLive),
  Effect.provide(Layer.mergeAll(EnvSecretStore, FetchHttpClient.layer, NodeFileSystem.layer)),
);

NodeRuntime.runMain(
  Effect.gen(function* () {
    const level = yield* logLevel;
    return yield* program.pipe(Effect.provideService(References.MinimumLogLevel, level));
  }),
);
