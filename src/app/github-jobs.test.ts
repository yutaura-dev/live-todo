import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Duration, Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { MissingSecretError } from "../core/config/secret-store.js";
import { EnvSecretStore } from "../core/config/secret-store.js";
import { TestDatabase } from "../core/db/test-database.js";
import { GitHubRateLimitedError, GitHubRequestError } from "../sources/github/github-adapter.js";
import conflictedPull from "../sources/github/__fixtures__/pull-42-open-conflict.json" with { type: "json" };
import { decodeAppConfig } from "./config/app-config.js";
import { githubBackoffUntil, makeGitHubJobs } from "./github-jobs.js";

const account = Effect.gen(function* () {
  const config = yield* decodeAppConfig({
    llmProfiles: { work: { provider: "none", model: "-" } },
    defaultLlmProfile: "work",
    accounts: [{ kind: "github", id: "work" }],
  });
  return config.accounts[0]!;
});

function fakeGitHub() {
  const stats = { requests: 0, inFlight: 0, max: 0 };
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      stats.requests++;
      stats.inFlight++;
      stats.max = Math.max(stats.max, stats.inFlight);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      stats.inFlight--;
      const body = url.pathname === "/notifications"
        ? []
        : url.pathname === "/search/issues"
          ? { items: [1, 2].map((number) => ({ repository_url: "https://api.github.com/repos/acme/app", html_url: `https://github.com/acme/app/pull/${number}`, updated_at: "2026-11-24T10:00:00Z", pull_request: { url: `https://api.github.com/repos/acme/app/pulls/${number}` } })) }
          : url.pathname.endsWith("/check-runs")
            ? { check_runs: [] }
            : url.pathname.endsWith("/reviews")
              ? []
              : conflictedPull;
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
    }),
  );
  return { stats, layer: Layer.succeed(HttpClient.HttpClient, http) };
}

const withEnv = (env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(EnvSecretStore), Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })));

const TOKEN_ENV = { LIVE_TODO_SECRET_GITHUB_WORK_TOKEN: "ghp_test" };

describe("makeGitHubJobs", () => {
  it.effect("アカウントごとに、通知の同期・見張り・待つ手順の確認・作成者の埋め直しのジョブを、それぞれの間隔で作る", () =>
    Effect.gen(function* () {
      const jobs = yield* makeGitHubJobs(yield* account);

      assert.deepStrictEqual(
        jobs.map((job) => [job.name, Duration.toMillis(job.interval)]),
        [
          ["github:work", Duration.toMillis("1 minute")],
          ["github:work:watch", Duration.toMillis("5 minutes")],
          ["github:work:waits", Duration.toMillis("5 minutes")],
          ["github:work:authors", Duration.toMillis("1 day")],
        ],
      );
    }).pipe(withEnv(TOKEN_ENV), Effect.provide(fakeGitHub().layer)));

  it.effect("トークンがなければ、どのキーがないかを示すエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeGitHubJobs(yield* account));

      assert.instanceOf(error, MissingSecretError);
      assert.strictEqual(error.key, "github.work.token");
    }).pipe(withEnv({}), Effect.provide(fakeGitHub().layer)));

  it.effect("2 つのジョブを同時に走らせても、GitHub へのリクエストは 1 本のキューで順番に送る", () =>
    Effect.gen(function* () {
      const github = fakeGitHub();
      const jobs = yield* makeGitHubJobs(yield* account).pipe(Effect.provide(github.layer));

      yield* Effect.all(jobs.map((job) => job.run), { concurrency: "unbounded" });

      assert.isAbove(github.stats.requests, 2);
      assert.strictEqual(github.stats.max, 1);
    }).pipe(withEnv(TOKEN_ENV), Effect.provide(TestDatabase)));
});

describe("makeGitHubJobs のフィルター", () => {
  it.effect("アカウントのリポジトリのフィルターを、見張りにも適用する", () =>
    Effect.gen(function* () {
      const config = yield* decodeAppConfig({
        llmProfiles: { work: { provider: "none", model: "-" } },
        defaultLlmProfile: "work",
        accounts: [{ kind: "github", id: "work", repositories: { exclude: ["acme/*"] } }],
      });
      const github = fakeGitHub();
      const jobs = yield* makeGitHubJobs(config.accounts[0]!).pipe(Effect.provide(github.layer));
      const watch = jobs.find((job) => job.name === "github:work:watch")!;

      yield* watch.run;

      assert.strictEqual(github.stats.requests, 1);
    }).pipe(withEnv(TOKEN_ENV), Effect.provide(TestDatabase)));
});

describe("makeGitHubJobs の判定", () => {
  it.effect("アカウントの LLM Profile で作った classifier で判定し、外から classifier を渡す必要がない", () =>
    Effect.gen(function* () {
      const github = fakeGitHub();
      const jobs = yield* makeGitHubJobs(yield* account).pipe(Effect.provide(github.layer));

      const runs = yield* Effect.forEach(jobs, (job) => Effect.exit(job.run));

      assert.isTrue(runs.every((exit) => exit._tag === "Success"));
    }).pipe(withEnv(TOKEN_ENV), Effect.provide(TestDatabase)));
});

describe("githubBackoffUntil", () => {
  it("レート制限のエラーなら、解除時刻まで休む", () => {
    const until = githubBackoffUntil(new GitHubRateLimitedError({ resetAt: "2026-11-25T01:00:00.000Z" }));

    assert.strictEqual(Option.map(until, (value) => value.toJSON()).pipe(Option.getOrUndefined), "2026-11-25T01:00:00.000Z");
  });

  it("それ以外のエラーなら、通常の間隔でやり直す", () => {
    assert.isTrue(Option.isNone(githubBackoffUntil(new GitHubRequestError({ message: "500" }))));
  });
});
