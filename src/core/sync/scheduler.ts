import { Cause, DateTime, Duration, Effect, Exit, Option } from "effect";

export interface SyncJob<E, R = never> {
  readonly name: string;
  readonly interval: Duration.Input;
  readonly run: Effect.Effect<unknown, E, R>;
  /** この失敗のあと、いつまで休むか（レート制限の解除時刻など）。none なら通常の間隔でやり直す */
  readonly backoffUntil: (error: E) => Option.Option<DateTime.Utc>;
}

const runJobForever = <E, R>(job: SyncJob<E, R>): Effect.Effect<never, never, R> =>
  Effect.gen(function* () {
    // Effect.exit で defect まで受け止める理由: 1 つのジョブの想定外の失敗で、定期実行の全体を止めないため。
    // 失敗はログに残し、次の間隔でやり直す。
    const exit = yield* Effect.exit(job.run);
    let waitMillis = Duration.toMillis(job.interval);

    if (Exit.isFailure(exit)) {
      yield* Effect.logWarning("同期に失敗した。次の間隔でやり直す").pipe(
        Effect.annotateLogs({ job: job.name, cause: Cause.pretty(exit.cause) }),
      );
      const until = Option.flatMap(Cause.findErrorOption(exit.cause), job.backoffUntil);
      if (Option.isSome(until)) {
        const now = yield* DateTime.now;
        waitMillis = Math.max(waitMillis, DateTime.toEpochMillis(until.value) - DateTime.toEpochMillis(now));
        yield* Effect.logWarning("休む時刻が示されたため、それまで同期しない").pipe(
          Effect.annotateLogs({ job: job.name, until: DateTime.formatIso(until.value) }),
        );
      }
    }

    yield* Effect.sleep(waitMillis);
  }).pipe(Effect.forever);

/** すべてのジョブを並行に、止まらずに回し続ける。1 つのジョブが休んだり失敗したりしても、ほかは止めない */
export const runJobs = <E, R>(jobs: ReadonlyArray<SyncJob<E, R>>): Effect.Effect<void, never, R> =>
  Effect.forEach(jobs, runJobForever, { concurrency: "unbounded", discard: true });
