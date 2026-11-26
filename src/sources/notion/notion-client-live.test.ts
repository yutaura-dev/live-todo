import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { NotionClient } from "./notion-client.js";
import { NotionClientLive, type NotionClientLiveOptions } from "./notion-client-live.js";

type Reply = { status?: number; body?: unknown; raw?: string };

const TOKEN = "v02%3Auser_token_or_cookies%3Asecret";
const USER = "11111111-1111-4111-8111-111111111111";
const SPACE = "44444444-4444-4444-8444-444444444444";
const USER_AGENT = "Mozilla/5.0 (Macintosh) TestBrowser/1.0";

/** 受け取ったリクエストを記録し、API の名前に応じた応答を返す偽の Notion */
function fakeNotion(route: (method: string, body: unknown) => Reply, options: Partial<NotionClientLiveOptions> = {}) {
  const requests: { url: URL; headers: Record<string, string>; body: unknown }[] = [];
  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const raw = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const body = raw === "" ? undefined : JSON.parse(raw);
      requests.push({ url, headers: { ...request.headers }, body });
      const reply = route(url.pathname.replace("/api/v3/", ""), body);
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } }),
      );
    }),
  );
  const layer = NotionClientLive({ token: Redacted.make(TOKEN), userId: USER, userAgent: USER_AGENT, minIntervalMs: 0, ...options }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return { requests, layer };
}

const withClient = <A, E>(layer: Layer.Layer<NotionClient>, use: (client: NotionClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* NotionClient);
  }).pipe(Effect.provide(layer));

const spacesBody = {
  [USER]: {
    notion_user: { [USER]: { spaceId: SPACE, value: { value: { id: USER, name: "yutaura" }, role: "reader" } } },
    space: {
      [SPACE]: { value: { value: { id: SPACE, name: "私用" }, role: "editor" } },
      gone: { role: "none" },
    },
  },
};

describe("NotionClientLive", () => {
  it.effect("www.notion.so の /api/v3 に JSON で POST し、セッションは Cookie・自分はヘッダ・UA はブラウザのものを付ける", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeNotion(() => ({ body: spacesBody }));

      yield* withClient(layer, (client) => client.me);

      const request = requests[0]!;
      assert.strictEqual(request.url.toString(), "https://www.notion.so/api/v3/getSpaces");
      assert.strictEqual(request.headers["cookie"], `token_v2=${TOKEN}; notion_user_id=${USER}`);
      assert.strictEqual(request.headers["x-notion-active-user-header"], USER);
      assert.strictEqual(request.headers["user-agent"], USER_AGENT);
      assert.strictEqual(request.headers["content-type"], "application/json");
      assert.deepStrictEqual(request.body, {});
    }));

  it.effect("接続先を app.notion.com にしたアカウントは、そちらに送る", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeNotion(() => ({ body: spacesBody }), { origin: "https://app.notion.com" });

      yield* withClient(layer, (client) => client.me);

      assert.strictEqual(requests[0]?.url.toString(), "https://app.notion.com/api/v3/getSpaces");
    }));

  it.effect("自分の名前と、見られるワークスペースの一覧を返す", () =>
    Effect.gen(function* () {
      const { layer } = fakeNotion(() => ({ body: spacesBody }));

      const me = yield* withClient(layer, (client) => client.me);

      assert.deepStrictEqual(me, { userId: USER, name: "yutaura", spaces: [{ id: SPACE, name: "私用" }] });
    }));

  it.effect("受信トレイは getNotificationLogV2 で、既読も未読も、まとめずに取る。レコードは入れ子を外して返す", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeNotion(() => ({
        body: {
          notificationIds: ["n1"],
          recordMap: { notification: { n1: { value: { value: { id: "n1", activity_id: "a1" }, role: "reader" } } } },
        },
      }));

      const log = yield* withClient(layer, (client) => client.notifications(SPACE, 50));

      assert.deepStrictEqual(requests[0]?.body, { spaceId: SPACE, size: 50, type: "unread_and_read", variant: "no_grouping" });
      assert.strictEqual(requests[0]?.headers["x-notion-space-id"], SPACE);
      assert.deepStrictEqual(log, { notificationIds: ["n1"], recordMap: { notification: { n1: { id: "n1", activity_id: "a1" } } } });
    }));

  it.effect("401 は、セッションが切れたことが分かる失敗にする（トークンは含めない）", () =>
    Effect.gen(function* () {
      const { layer } = fakeNotion(() => ({ status: 401, body: { name: "UnauthorizedError", message: "Token was invalid or expired." } }));

      const error = yield* withClient(layer, (client) => client.me).pipe(Effect.flip);

      assert.strictEqual(error._tag, "NotionRequestError");
      assert.include(error.message, "セッション");
      assert.notInclude(error.message, TOKEN);
    }));

  it.effect("429 は、60 秒後まで休む失敗にする", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-26T00:00:00.000Z"));
      const { layer } = fakeNotion(() => ({ status: 429, body: {} }));

      const error = yield* withClient(layer, (client) => client.me).pipe(Effect.flip);

      assert.strictEqual(error._tag, "NotionRateLimitedError");
      if (error._tag === "NotionRateLimitedError") assert.strictEqual(error.resetAt, DateTime.formatIso(DateTime.makeUnsafe("2026-11-26T00:01:00.000Z")));
    }));

  it.effect("ほかの失敗は、Notion が返したエラーの名前つきにする。JSON でない応答（HTML など）も失敗にする", () =>
    Effect.gen(function* () {
      const failed = yield* withClient(fakeNotion(() => ({ status: 400, body: { name: "ValidationError", message: "Invalid input." } })).layer, (client) => client.me).pipe(Effect.flip);
      const html = yield* withClient(fakeNotion(() => ({ raw: "<html>Just a moment...</html>" })).layer, (client) => client.me).pipe(Effect.flip);

      assert.include(failed.message, "ValidationError");
      assert.include(html.message, "JSON");
    }));

  it.effect("応答の形が想定と違えば、そうと分かる失敗にする", () =>
    Effect.gen(function* () {
      const { layer } = fakeNotion(() => ({ body: { notificationIds: "x" } }));

      const error = yield* withClient(layer, (client) => client.notifications(SPACE, 50)).pipe(Effect.flip);

      assert.include(error.message, "形");
    }));
});
