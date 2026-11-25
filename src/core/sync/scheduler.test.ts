import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Fiber, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { runJobs, type SyncJob } from "./scheduler.js";

class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { until: Schema.String }) {}
class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}

const START = Date.parse("2026-11-25T00:00:00Z");

const countingJob = (name: string, outcome: (runCount: number) => Effect.Effect<void, RateLimited | Boom> = () => Effect.void) =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(0);
    const job: SyncJob<RateLimited | Boom> = {
      name,
      interval: "1 minute",
      run: Ref.updateAndGet(runs, (count) => count + 1).pipe(Effect.flatMap(outcome)),
      backoffUntil: (error) => (error._tag === "RateLimited" ? DateTime.make(error.until) : Option.none()),
    };
    return { job, runs };
  });

const runFor = <E>(jobs: ReadonlyArray<SyncJob<E>>, minutes: number) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(runJobs(jobs));
    for (let minute = 0; minute < minutes; minute++) yield* TestClock.adjust("1 minute");
    yield* Fiber.interrupt(fiber);
  });

describe("runJobs", () => {
  it.effect("成功したジョブを、間隔ごとに繰り返し実行する", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const { job, runs } = yield* countingJob("a");

      yield* runFor([job], 2);

      assert.strictEqual(yield* Ref.get(runs), 3);
    }));

  it.effect("失敗しても止まらず、次の間隔でまた実行する", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const { job, runs } = yield* countingJob("a", () => Effect.fail(new Boom()));

      yield* runFor([job], 2);

      assert.strictEqual(yield* Ref.get(runs), 3);
    }));

  it.effect("想定外の失敗（defect）でも止まらない", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const { job, runs } = yield* countingJob("a", () => Effect.die(new Error("bug")));

      yield* runFor([job], 2);

      assert.strictEqual(yield* Ref.get(runs), 3);
    }));

  it.effect("休む時刻が示されたら、その時刻まで実行しない", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const { job, runs } = yield* countingJob("a", (count) =>
        count === 1 ? Effect.fail(new RateLimited({ until: "2026-11-25T00:30:00Z" })) : Effect.void,
      );

      const fiber = yield* Effect.forkChild(runJobs([job]));
      yield* TestClock.adjust("29 minutes");
      const beforeReset = yield* Ref.get(runs);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.interrupt(fiber);

      assert.strictEqual(beforeReset, 1);
      assert.strictEqual(yield* Ref.get(runs), 2);
    }));

  it.effect("休む時刻がすでに過ぎていても、少なくとも間隔は空ける", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const { job, runs } = yield* countingJob("a", (count) =>
        count === 1 ? Effect.fail(new RateLimited({ until: "2026-11-24T00:00:00Z" })) : Effect.void,
      );

      const fiber = yield* Effect.forkChild(runJobs([job]));
      yield* TestClock.adjust("30 seconds");
      const halfway = yield* Ref.get(runs);
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.interrupt(fiber);

      assert.strictEqual(halfway, 1);
      assert.strictEqual(yield* Ref.get(runs), 2);
    }));

  it.effect("1 つのジョブが休んでいる間も、ほかのジョブは止まらない", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const limited = yield* countingJob("limited", () => Effect.fail(new RateLimited({ until: "2026-11-25T01:00:00Z" })));
      const healthy = yield* countingJob("healthy");

      yield* runFor([limited.job, healthy.job], 3);

      assert.strictEqual(yield* Ref.get(limited.runs), 1);
      assert.strictEqual(yield* Ref.get(healthy.runs), 4);
    }));
});
