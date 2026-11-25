import { Effect, type Exit } from "effect";
import type { SyncJob } from "./scheduler.js";

export type JobResult<E> = { name: string; exit: Exit.Exit<unknown, E> };

/** 各ジョブを 1 回ずつ順番に実行する。失敗しても残りのジョブは続ける（手元での動作確認用） */
export const runJobsOnce = <E, R>(jobs: ReadonlyArray<SyncJob<E, R>>): Effect.Effect<JobResult<E>[], never, R> =>
  Effect.forEach(jobs, (job) => Effect.exit(job.run).pipe(Effect.map((exit) => ({ name: job.name, exit }))));
