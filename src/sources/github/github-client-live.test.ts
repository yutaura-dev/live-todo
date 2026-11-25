import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { GitHubClient, GitHubRateLimitedError, GitHubRequestError } from "./github-adapter.js";
import { GitHubClientLive } from "./github-client-live.js";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

const TOKEN = "ghp_test_token";

/** 受け取ったリクエストを記録し、URL に応じた応答を返す偽の GitHub */
function fakeGitHub(route: (url: URL) => Reply) {
  const requests: { url: URL; headers: Record<string, string> }[] = [];
  const concurrency = { inFlight: 0, max: 0 };
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      requests.push({ url, headers: { ...request.headers } });
      concurrency.inFlight++;
      concurrency.max = Math.max(concurrency.max, concurrency.inFlight);
      // 応答を返す前に他の fiber に順番を譲り、並行に送っていれば同時に処理中になるようにする
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      concurrency.inFlight--;
      const reply = route(url);
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json", ...reply.headers },
        }),
      );
    }),
  );
  const layer = GitHubClientLive({ token: Redacted.make(TOKEN) }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return { requests, concurrency, layer };
}

const withClient = <A, E>(layer: Layer.Layer<GitHubClient>, use: (client: GitHubClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* GitHubClient);
  }).pipe(Effect.provide(layer));

describe("GitHubClientLive", () => {
  it.effect("トークン・API バージョン・Accept を付け、既読も含めて since 以降の通知を取得する", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeGitHub(() => ({ body: [{ id: "1" }] }));

      const result = yield* withClient(layer, (client) =>
        client.listNotifications({ since: "2026-11-24T00:00:00Z", all: true }),
      );

      const [request] = requests;
      assert.deepStrictEqual(result, [{ id: "1" }]);
      assert.strictEqual(`${request?.url.origin}${request?.url.pathname}`, "https://api.github.com/notifications");
      assert.strictEqual(request?.url.searchParams.get("all"), "true");
      assert.strictEqual(request?.url.searchParams.get("since"), "2026-11-24T00:00:00Z");
      assert.strictEqual(request?.headers["authorization"], `Bearer ${TOKEN}`);
      assert.strictEqual(request?.headers["x-github-api-version"], "2022-11-28");
      assert.strictEqual(request?.headers["accept"], "application/vnd.github+json");
    }));

  it.effect("Link ヘッダーの next をたどって、すべてのページの通知をつなげる", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeGitHub((url) =>
        url.searchParams.get("page") === "2"
          ? { body: [{ id: "2" }] }
          : {
              body: [{ id: "1" }],
              headers: { link: '<https://api.github.com/notifications?all=true&page=2>; rel="next", <https://api.github.com/notifications?page=2>; rel="last"' },
            },
      );

      const result = yield* withClient(layer, (client) =>
        client.listNotifications({ since: "2026-11-24T00:00:00Z", all: true }),
      );

      assert.deepStrictEqual(result, [{ id: "1" }, { id: "2" }]);
      assert.strictEqual(requests.length, 2);
    }));

  it.effect("自分の open な PR を検索し、複数ページの items を 1 つにまとめる", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeGitHub((url) =>
        url.searchParams.get("page") === "2"
          ? { body: { total_count: 2, items: [{ number: 2 }] } }
          : {
              body: { total_count: 2, items: [{ number: 1 }] },
              headers: { link: '<https://api.github.com/search/issues?page=2>; rel="next"' },
            },
      );

      const result = yield* withClient(layer, (client) => client.searchMyOpenPullRequests);

      assert.deepStrictEqual(result, { items: [{ number: 1 }, { number: 2 }] });
      assert.strictEqual(requests[0]?.url.searchParams.get("q"), "is:pr is:open author:@me archived:false");
    }));

  it.effect("check run は repo と commit から API のパスを組み立て、check_runs をまとめて返す", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeGitHub(() => ({ body: { total_count: 1, check_runs: [{ name: "test" }] } }));

      const result = yield* withClient(layer, (client) => client.listCheckRuns("acme/app", "abc123"));

      assert.deepStrictEqual(result, { check_runs: [{ name: "test" }] });
      assert.strictEqual(requests[0]?.url.pathname, "/repos/acme/app/commits/abc123/check-runs");
    }));

  it.effect("レビューは PR の API の URL の下から取得する", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeGitHub(() => ({ body: [{ state: "APPROVED" }] }));

      const result = yield* withClient(layer, (client) =>
        client.listReviews("https://api.github.com/repos/acme/app/pulls/42"),
      );

      assert.deepStrictEqual(result, [{ state: "APPROVED" }]);
      assert.strictEqual(requests[0]?.url.pathname, "/repos/acme/app/pulls/42/reviews");
    }));

  it.effect("対象が見つからない（404）ときは none を返し、見つかれば中身を返す", () =>
    Effect.gen(function* () {
      const { layer } = fakeGitHub((url) =>
        url.pathname.endsWith("/42") ? { body: { number: 42 } } : { status: 404, body: { message: "Not Found" } },
      );

      const found = yield* withClient(layer, (client) => client.getPullRequest("https://api.github.com/repos/acme/app/pulls/42"));
      const missing = yield* withClient(layer, (client) => client.getSubject("https://api.github.com/repos/acme/app/issues/7"));

      assert.deepStrictEqual(found, Option.some({ number: 42 }));
      assert.isTrue(Option.isNone(missing));
    }));

  it.effect("api.github.com 以外の URL には、トークンを送らずエラーにする", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeGitHub(() => ({ body: {} }));

      const error = yield* Effect.flip(withClient(layer, (client) => client.getSubject("https://evil.example.com/repos/x")));

      assert.instanceOf(error, GitHubRequestError);
      assert.strictEqual(requests.length, 0);
    }));

  it.effect("レート制限の残りが 0 で拒否されたら、解除される時刻つきのエラーにする", () =>
    Effect.gen(function* () {
      const { layer } = fakeGitHub(() => ({
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Date.parse("2026-11-25T01:00:00Z") / 1000) },
      }));

      const error = yield* Effect.flip(withClient(layer, (client) => client.searchMyOpenPullRequests));

      assert.instanceOf(error, GitHubRateLimitedError);
      assert.strictEqual(error.resetAt, "2026-11-25T01:00:00.000Z");
    }));

  it.effect("retry-after 付きで拒否されたら、今の時刻にその秒数を足した時刻を解除時刻にする", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
      const { layer } = fakeGitHub(() => ({ status: 429, body: {}, headers: { "retry-after": "60" } }));

      const error = yield* Effect.flip(withClient(layer, (client) => client.searchMyOpenPullRequests));

      assert.instanceOf(error, GitHubRateLimitedError);
      assert.strictEqual(error.resetAt, "2026-11-25T00:01:00.000Z");
    }));

  it.effect("それ以外の失敗は GitHubRequestError にし、メッセージにトークンを含めない", () =>
    Effect.gen(function* () {
      const { layer } = fakeGitHub(() => ({ status: 401, body: { message: "Bad credentials" } }));

      const error = yield* Effect.flip(withClient(layer, (client) => client.searchMyOpenPullRequests));

      assert.instanceOf(error, GitHubRequestError);
      assert.include(error.message, "401");
      assert.notInclude(error.message, TOKEN);
    }));

  it.effect("同じクライアントへのリクエストは、同時に呼ばれても 1 つずつ順番に送る", () =>
    Effect.gen(function* () {
      const { concurrency, requests, layer } = fakeGitHub(() => ({ body: { number: 1 } }));

      yield* withClient(layer, (client) =>
        Effect.all(
          [1, 2, 3].map((number) => client.getPullRequest(`https://api.github.com/repos/acme/app/pulls/${number}`)),
          { concurrency: "unbounded" },
        ),
      );

      assert.strictEqual(requests.length, 3);
      assert.strictEqual(concurrency.max, 1);
    }));

  it.effect("レート制限を受けたあとは、解除時刻まで API に送らずに同じエラーを返す", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
      const { requests, layer } = fakeGitHub(() => ({
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Date.parse("2026-11-25T01:00:00Z") / 1000) },
      }));

      const errors = yield* withClient(layer, (client) =>
        Effect.all([Effect.flip(client.searchMyOpenPullRequests), Effect.flip(client.listReviews("https://api.github.com/repos/acme/app/pulls/42"))]),
      );

      assert.strictEqual(requests.length, 1);
      for (const error of errors) {
        assert.instanceOf(error, GitHubRateLimitedError);
        assert.strictEqual(error.resetAt, "2026-11-25T01:00:00.000Z");
      }
    }));

  it.effect("解除時刻を過ぎたら、また API に送る", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
      let limited = true;
      const { requests, layer } = fakeGitHub(() =>
        limited
          ? {
              status: 403,
              body: {},
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Date.parse("2026-11-25T01:00:00Z") / 1000) },
            }
          : { body: { items: [] } },
      );

      const result = yield* withClient(layer, (client) =>
        Effect.gen(function* () {
          yield* Effect.flip(client.searchMyOpenPullRequests);
          limited = false;
          yield* TestClock.setTime(Date.parse("2026-11-25T01:00:00Z"));
          return yield* client.searchMyOpenPullRequests;
        }),
      );

      assert.deepStrictEqual(result, { items: [] });
      assert.strictEqual(requests.length, 2);
    }));
});
