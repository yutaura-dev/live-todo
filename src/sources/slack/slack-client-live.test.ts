import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SlackClient } from "./slack-client.js";
import { SlackClientLive } from "./slack-client-live.js";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

const TOKEN = "xoxc-test-token";
const COOKIE = "xoxd-test/cookie+value";
const USER_AGENT = "Mozilla/5.0 (Macintosh) TestBrowser/1.0";

/** 受け取ったリクエストを記録し、メソッドに応じた応答を返す偽の Slack */
function fakeSlack(route: (method: string, form: URLSearchParams) => Reply) {
  const requests: { url: URL; headers: Record<string, string>; form: URLSearchParams }[] = [];
  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const raw = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const form = new URLSearchParams(raw);
      requests.push({ url, headers: { ...request.headers }, form });
      const reply = route(url.pathname.replace("/api/", ""), form);
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(reply.body ?? { ok: true }), {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json", ...reply.headers },
        }),
      );
    }),
  );
  const layer = SlackClientLive({
    workspace: "acme.slack.com",
    token: Redacted.make(TOKEN),
    cookie: Redacted.make(COOKIE),
    userAgent: USER_AGENT,
    minIntervalMs: 0,
  }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));
  return { requests, layer };
}

const withClient = <A, E>(layer: Layer.Layer<SlackClient>, use: (client: SlackClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* SlackClient);
  }).pipe(Effect.provide(layer));

describe("SlackClientLive", () => {
  it.effect("ワークスペースのドメインに form で POST し、トークンは本文・セッションは Cookie・UA はブラウザのものを付ける", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeSlack(() => ({ body: { ok: true, saved_items: [], response_metadata: { next_cursor: "" }, counts: { total_count: 0 } } }));

      yield* withClient(layer, (client) => client.savedList({}));

      const request = requests[0]!;
      assert.strictEqual(request.url.toString(), "https://acme.slack.com/api/saved.list");
      assert.strictEqual(request.headers["cookie"], `d=${encodeURIComponent(COOKIE)}`);
      assert.strictEqual(request.headers["user-agent"], USER_AGENT);
      assert.strictEqual(request.headers["origin"], "https://app.slack.com");
      assert.strictEqual(request.form.get("token"), TOKEN);
      assert.strictEqual(request.form.get("_x_reason"), "saved-api/savedList");
      assert.strictEqual(request.form.get("limit"), "50");
      assert.strictEqual(request.form.get("include_tombstones"), "true");
      assert.isUndefined(request.headers["authorization"]);
    }));

  it.effect("To-do・Saved の一覧を、次のページの cursor と全件数つきで返す（filter と cursor を渡せる）", () =>
    Effect.gen(function* () {
      const item = { item_id: "C1", item_type: "message", ts: "1764000000.123456", todo_state: "to_do", date_due: 1764064800 };
      const { requests, layer } = fakeSlack(() => ({
        body: { ok: true, saved_items: [item], counts: { total_count: 4 }, response_metadata: { next_cursor: "next" } },
      }));

      const page = yield* withClient(layer, (client) => client.savedList({ filter: "completed", cursor: "c1" }));

      assert.deepStrictEqual(page, { items: [item], nextCursor: "next", totalCount: 4 });
      assert.strictEqual(requests[0]?.form.get("filter"), "completed");
      assert.strictEqual(requests[0]?.form.get("cursor"), "c1");
    }));

  it.effect("ok: false は、Slack が返した理由つきの失敗にする（HTTP が 200 でも）", () =>
    Effect.gen(function* () {
      const { layer } = fakeSlack(() => ({ body: { ok: false, error: "invalid_auth" } }));

      const error = yield* withClient(layer, (client) => client.savedList({})).pipe(Effect.flip);

      assert.strictEqual(error._tag, "SlackRequestError");
      assert.include(error.message, "invalid_auth");
      assert.include(error.message, "セッション");
      assert.notInclude(error.message, TOKEN);
    }));

  it.effect("レート制限（429・ratelimited）は、Retry-After の時刻まで休む失敗にする", () =>
    Effect.gen(function* () {
      const { layer } = fakeSlack(() => ({ status: 429, body: { ok: false, error: "ratelimited" }, headers: { "retry-after": "30" } }));

      const error = yield* withClient(layer, (client) => client.savedList({})).pipe(Effect.flip);

      assert.strictEqual(error._tag, "SlackRateLimitedError");
    }));

  it.effect("メッセージの本文は conversations.history で取り、見つからなければスレッドの返信として conversations.replies で取る", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeSlack((method) =>
        method === "conversations.history"
          ? { body: { ok: true, messages: [] } }
          : { body: { ok: true, messages: [{ ts: "1.0", text: "親" }, { ts: "2.0", text: "返信の本文", user: "U1" }] } },
      );

      const message = yield* withClient(layer, (client) => client.message("C1", "2.0"));

      assert.deepStrictEqual(message, Option.some({ text: "返信の本文", user: "U1" }));
      assert.deepStrictEqual(
        requests.map((request) => [request.url.pathname, request.form.get("channel"), request.form.get("latest") ?? request.form.get("ts")]),
        [
          ["/api/conversations.history", "C1", "2.0"],
          ["/api/conversations.replies", "C1", "2.0"],
        ],
      );
    }));

  it.effect("ユーザーの表示名を users.info で取る（表示名がなければ本名、それもなければユーザー名）", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeSlack(() => ({ body: { ok: true, user: { name: "yutaura", real_name: "Yuta Ura", profile: { display_name: "" } } } }));

      assert.deepStrictEqual(yield* withClient(layer, (client) => client.userName("U1")), Option.some("Yuta Ura"));
      assert.strictEqual(requests[0]?.form.get("user"), "U1");
    }));

  it.effect("チャンネルの名前と、DM かどうかを conversations.info で取る。見られないチャンネルなら none", () =>
    Effect.gen(function* () {
      const found = fakeSlack(() => ({ body: { ok: true, channel: { id: "C1", name: "general", is_im: false } } }));
      const missing = fakeSlack(() => ({ body: { ok: false, error: "channel_not_found" } }));

      assert.deepStrictEqual(yield* withClient(found.layer, (client) => client.channel("C1")), Option.some({ name: "general", isDirect: false }));
      assert.deepStrictEqual(yield* withClient(missing.layer, (client) => client.channel("C1")), Option.none());
    }));

  it.effect("To-do を完了にするときは、Web クライアントと同じ組み合わせ（mark・todo_state・date_due）で saved.update を送る", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeSlack(() => ({ body: { ok: true } }));

      yield* withClient(layer, (client) => client.completeSaved("C1", "1.0"));

      const form = requests[0]!.form;
      assert.strictEqual(requests[0]?.url.pathname, "/api/saved.update");
      assert.deepStrictEqual(
        ["item_type", "item_id", "ts", "mark", "todo_state", "date_due", "_x_reason"].map((key) => form.get(key)),
        ["message", "C1", "1.0", "completed", "completed", "0", "saved-api/updateSavedMessage"],
      );
    }));

  it.effect("To-do・Saved から外すときは、対象を必ず 3 つとも指定して saved.delete を送る（省くとリスト全体に効くおそれがあるため）", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeSlack(() => ({ body: { ok: true } }));

      yield* withClient(layer, (client) => client.removeSaved("C1", "1.0"));

      assert.strictEqual(requests[0]?.url.pathname, "/api/saved.delete");
      assert.deepStrictEqual(["item_type", "item_id", "ts"].map((key) => requests[0]!.form.get(key)), ["message", "C1", "1.0"]);
    }));

  it.effect("セッションの持ち主（自分）とワークスペースを auth.test で確かめる", () =>
    Effect.gen(function* () {
      const { layer } = fakeSlack(() => ({ body: { ok: true, user_id: "U1", user: "me", team: "Acme", url: "https://acme.slack.com/" } }));

      assert.deepStrictEqual(yield* withClient(layer, (client) => client.authTest), { userId: "U1", user: "me", team: "Acme" });
    }));
});
