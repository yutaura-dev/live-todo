import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option, Schema } from "effect";
import { runJobsOnce } from "./run-once.js";
import type { SyncJob } from "./scheduler.js";

class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}

const job = (name: string, run: Effect.Effect<unknown, Boom>): SyncJob<Boom> => ({
  name,
  interval: "1 minute",
  run,
  backoffUntil: () => Option.none(),
});

describe("runJobsOnce", () => {
  it.effect("各ジョブを 1 回ずつ実行し、ジョブごとの結果を返す", () =>
    Effect.gen(function* () {
      const results = yield* runJobsOnce([job("a", Effect.succeed({ created: 1 })), job("b", Effect.succeed({ created: 2 }))]);

      assert.deepStrictEqual(
        results.map((result) => [result.name, Exit.isSuccess(result.exit) ? result.exit.value : "failed"]),
        [["a", { created: 1 }], ["b", { created: 2 }]],
      );
    }));

  it.effect("1 つのジョブが失敗しても、残りのジョブは実行する", () =>
    Effect.gen(function* () {
      const results = yield* runJobsOnce([job("a", Effect.fail(new Boom())), job("b", Effect.succeed("ok"))]);

      assert.deepStrictEqual(results.map((result) => [result.name, Exit.isSuccess(result.exit)]), [["a", false], ["b", true]]);
    }));
});
