import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { GraphClient, GraphClientLive } from "./graph-client.js";
import { MicrosoftToken } from "./microsoft-token.js";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeGraph(route: (url: URL, attempt: number) => Reply) {
  const requests: { url: URL; headers: Record<string, string> }[] = [];
  let invalidated = 0;
  let current = 1;
  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push({ url, headers: { ...request.headers } });
      const reply = route(url, requests.length);
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json", ...reply.headers } }));
    }),
  );
  const token = MicrosoftToken.of({
    accessToken: Effect.sync(() => Redacted.make(`token-${current}`)),
    invalidate: Effect.sync(() => {
      invalidated++;
      current++;
    }),
  });
  const layer = GraphClientLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)), Layer.provide(Layer.succeed(MicrosoftToken, token)));
  return { requests, layer, invalidatedCount: () => invalidated };
}

const withGraph = <A, E>(layer: Layer.Layer<GraphClient>, use: (graph: GraphClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* GraphClient);
  }).pipe(Effect.provide(layer));

describe("GraphClientLive", () => {
  it.effect("graph.microsoft.com の v1.0 に、アクセストークンを Bearer で付けて GET する", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeGraph(() => ({ body: { id: "me" } }));

      const body = yield* withGraph(layer, (graph) => graph.get("/me", { query: { $select: "id,mail" }, headers: { prefer: 'outlook.timezone="UTC"' } }));

      assert.deepStrictEqual(body, { id: "me" });
      assert.strictEqual(requests[0]?.url.toString(), "https://graph.microsoft.com/v1.0/me?%24select=id%2Cmail");
      assert.strictEqual(requests[0]?.headers["authorization"], "Bearer token-1");
      assert.strictEqual(requests[0]?.headers["prefer"], 'outlook.timezone="UTC"');
    }));

  it.effect("401 なら、トークンを取り直して 1 回だけやり直す", () =>
    Effect.gen(function* () {
      const { requests, layer, invalidatedCount } = fakeGraph((_, attempt) => (attempt === 1 ? { status: 401, body: { error: { code: "InvalidAuthenticationToken" } } } : { body: { ok: true } }));

      const body = yield* withGraph(layer, (graph) => graph.get("/me"));

      assert.deepStrictEqual(body, { ok: true });
      assert.strictEqual(invalidatedCount(), 1);
      assert.strictEqual(requests[1]?.headers["authorization"], "Bearer token-2");
    }));

  it.effect("429・503 は、Retry-After の秒数まで休む失敗にする", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-26T00:00:00.000Z"));
      const { layer } = fakeGraph(() => ({ status: 429, headers: { "retry-after": "30" }, body: { error: { code: "TooManyRequests" } } }));

      const error = yield* withGraph(layer, (graph) => graph.get("/me")).pipe(Effect.flip);

      assert.strictEqual(error._tag, "MicrosoftRateLimitedError");
      if (error._tag === "MicrosoftRateLimitedError") assert.strictEqual(error.resetAt, DateTime.formatIso(DateTime.makeUnsafe("2026-11-26T00:00:30.000Z")));
    }));

  it.effect("ほかの失敗は、Graph が返したエラーのコードつきにする（403 なら権限を確かめるよう促す）", () =>
    Effect.gen(function* () {
      const { layer } = fakeGraph(() => ({ status: 403, body: { error: { code: "Forbidden", message: "Missing scope" } } }));

      const error = yield* withGraph(layer, (graph) => graph.get("/me/chats")).pipe(Effect.flip);

      assert.strictEqual(error._tag, "MicrosoftRequestError");
      assert.include(error.message, "Forbidden");
      assert.include(error.message, "権限");
    }));

  it.effect("getAll は @odata.nextLink をたどって value をつなぐ（上限のページ数まで）", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeGraph((url) =>
        url.searchParams.get("page") === "2"
          ? { body: { value: [{ id: "b" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/events?page=3" } }
          : { body: { value: [{ id: "a" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/events?page=2" } },
      );

      const items = yield* withGraph(layer, (graph) => graph.getAll("/me/events", { maxPages: 2 }));

      assert.deepStrictEqual(items, [{ id: "a" }, { id: "b" }]);
      assert.strictEqual(requests.length, 2);
    }));

  it.effect("nextLink が Graph の外を指していたら、たどらない", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeGraph(() => ({ body: { value: [{ id: "a" }], "@odata.nextLink": "https://evil.example/steal" } }));

      const items = yield* withGraph(layer, (graph) => graph.getAll("/me/events"));

      assert.deepStrictEqual(items, [{ id: "a" }]);
      assert.strictEqual(requests.length, 1);
    }));
});
