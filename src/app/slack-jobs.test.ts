import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, DateTime, Duration, Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { EnvSecretStore, MissingSecretError } from "../core/config/secret-store.js";
import { SlackRateLimitedError, SlackRequestError } from "../sources/slack/slack-client.js";
import { decodeAppConfig } from "./config/app-config.js";
import { makeSlackJobs, slackBackoffUntil } from "./slack-jobs.js";

const account = Effect.gen(function* () {
  const config = yield* decodeAppConfig({
    llmProfiles: { work: { provider: "none", model: "-" } },
    defaultLlmProfile: "work",
    accounts: [],
    slackAccounts: [{ kind: "slack", id: "home", workspace: "yutaura.slack.com", userAgent: "Mozilla/5.0 TestBrowser" }],
  });
  return config.slackAccounts[0]!;
});

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ ok: true }))))),
);

const withEnv = (env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(EnvSecretStore), Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })));

describe("makeSlackJobs", () => {
  it.effect("ワークスペースごとに To-do・Saved の同期のジョブを作る（Slack の制限に合わせて 2 分おき）", () =>
    Effect.gen(function* () {
      const jobs = yield* makeSlackJobs(yield* account);

      assert.deepStrictEqual(jobs.map((job) => [job.name, Duration.toMillis(job.interval)]), [["slack:home", Duration.toMillis("2 minutes")]]);
    }).pipe(withEnv({ LIVE_TODO_SECRET_SLACK_HOME_TOKEN: "xoxc-test", LIVE_TODO_SECRET_SLACK_HOME_COOKIE: "xoxd-test" }), Effect.provide(http)));

  it.effect("トークンか Cookie がなければ、どのキーがないかを示すエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeSlackJobs(yield* account));

      assert.instanceOf(error, MissingSecretError);
      assert.strictEqual(error.key, "slack.home.cookie");
    }).pipe(withEnv({ LIVE_TODO_SECRET_SLACK_HOME_TOKEN: "xoxc-test" }), Effect.provide(http)));
});

describe("slackBackoffUntil", () => {
  it("レート制限なら、その時刻まで休む。ほかの失敗は通常の間隔でやり直す", () => {
    const resetAt = "2026-11-26T03:00:00.000Z";
    assert.deepStrictEqual(Option.map(slackBackoffUntil(new SlackRateLimitedError({ resetAt })), DateTime.formatIso), Option.some(resetAt));
    assert.isTrue(Option.isNone(slackBackoffUntil(new SlackRequestError({ message: "x" }))));
  });
});
