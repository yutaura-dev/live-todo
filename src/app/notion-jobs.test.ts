import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, DateTime, Duration, Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { EnvSecretStore, MissingSecretError } from "../core/config/secret-store.js";
import { NotionRateLimitedError, NotionRequestError } from "../sources/notion/notion-client.js";
import { decodeAppConfig } from "./config/app-config.js";
import { makeNotionJobs, notionBackoffUntil } from "./notion-jobs.js";

const account = Effect.gen(function* () {
  const config = yield* decodeAppConfig({
    llmProfiles: { work: { provider: "none", model: "-" } },
    defaultLlmProfile: "work",
    accounts: [],
    notionAccounts: [{ kind: "notion", id: "notes", userId: "11111111-1111-4111-8111-111111111111", userAgent: "Mozilla/5.0 TestBrowser" }],
  });
  return config.notionAccounts[0]!;
});

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")))),
);

const withEnv = (env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(EnvSecretStore), Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })));

describe("makeNotionJobs", () => {
  it.effect("アカウントごとに、受信トレイの同期のジョブ（3 分おき）を作る", () =>
    Effect.gen(function* () {
      const jobs = yield* makeNotionJobs(yield* account);

      assert.deepStrictEqual(jobs.map((job) => [job.name, Duration.toMillis(job.interval)]), [["notion:notes:inbox", Duration.toMillis("3 minutes")]]);
    }).pipe(withEnv({ LIVE_TODO_SECRET_NOTION_NOTES_TOKEN: "v02:test" }), Effect.provide(http)));

  it.effect("token_v2 がなければ、どのキーがないかを示すエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeNotionJobs(yield* account));

      assert.instanceOf(error, MissingSecretError);
      assert.strictEqual(error.key, "notion.notes.token");
    }).pipe(withEnv({}), Effect.provide(http)));
});

describe("notionBackoffUntil", () => {
  it("レート制限なら、その時刻まで休む。ほかの失敗は通常の間隔でやり直す", () => {
    const resetAt = "2026-11-26T03:00:00.000Z";
    assert.deepStrictEqual(Option.map(notionBackoffUntil(new NotionRateLimitedError({ resetAt })), DateTime.formatIso), Option.some(resetAt));
    assert.isTrue(Option.isNone(notionBackoffUntil(new NotionRequestError({ message: "x" }))));
  });
});
