import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { pollDeviceToken, refreshTokens, requestDeviceCode } from "./microsoft-auth.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const app = { tenantId: TENANT, clientId: CLIENT, scopes: ["offline_access", "User.Read", "Calendars.Read"] };

/** 受け取ったフォームを記録し、順に応答を返す偽の Microsoft のサインイン */
function fakeLogin(replies: ReadonlyArray<{ status?: number; body: unknown }>) {
  const requests: { url: string; form: URLSearchParams }[] = [];
  let at = 0;
  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const raw = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ url: url.toString(), form: new URLSearchParams(raw) });
      const reply = replies[Math.min(at++, replies.length - 1)]!;
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } }));
    }),
  );
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, http) };
}

const tokens = { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" };

describe("requestDeviceCode", () => {
  it.effect("テナントの devicecode に client ID とスコープを送り、ユーザーに見せるコードと開く URL を返す", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeLogin([
        { body: { device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5, message: "..." } },
      ]);

      const code = yield* requestDeviceCode(app).pipe(Effect.provide(layer));

      assert.strictEqual(requests[0]?.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`);
      assert.strictEqual(requests[0]?.form.get("client_id"), CLIENT);
      assert.strictEqual(requests[0]?.form.get("scope"), "offline_access User.Read Calendars.Read");
      assert.deepStrictEqual({ ...code, deviceCode: Redacted.value(code.deviceCode) }, {
        deviceCode: "dc",
        userCode: "ABCD-EFGH",
        verificationUri: "https://microsoft.com/devicelogin",
        expiresInSeconds: 900,
        intervalSeconds: 5,
      });
    }));

  it.effect("断られたら（アプリが見つからないなど）、Microsoft が返した理由つきの失敗にする", () =>
    Effect.gen(function* () {
      const { layer } = fakeLogin([{ status: 400, body: { error: "unauthorized_client", error_description: "AADSTS700016: Application not found" } }]);

      const error = yield* requestDeviceCode(app).pipe(Effect.provide(layer), Effect.flip);

      assert.strictEqual(error._tag, "MicrosoftAuthError");
      assert.include(error.message, "unauthorized_client");
      assert.include(error.message, "AADSTS700016");
    }));
});

describe("pollDeviceToken", () => {
  const code = { deviceCode: Redacted.make("dc"), userCode: "ABCD-EFGH", verificationUri: "https://microsoft.com/devicelogin", expiresInSeconds: 900, intervalSeconds: 5 };

  it.effect("サインインが済むまで間隔を空けて問い合わせ、済んだらトークンを返す（slow_down なら間隔を 5 秒延ばす）", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeLogin([
        { status: 400, body: { error: "authorization_pending" } },
        { status: 400, body: { error: "slow_down" } },
        { body: tokens },
      ]);

      const fiber = yield* pollDeviceToken(app, code).pipe(Effect.provide(layer), Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(requests.length, 1);
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(requests.length, 2);
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(requests.length, 2);
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(requests[0]?.form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
      assert.strictEqual(requests[0]?.form.get("device_code"), "dc");
      assert.strictEqual(Redacted.value(result.refreshToken), "rt-1");
      assert.strictEqual(result.expiresInSeconds, 3600);
    }));

  it.effect("コードの期限が切れたか、ユーザーが断ったら、やり直しを促す失敗にする", () =>
    Effect.gen(function* () {
      const expired = fakeLogin([{ status: 400, body: { error: "expired_token" } }]);
      const declined = fakeLogin([{ status: 400, body: { error: "authorization_declined" } }]);

      const first = yield* pollDeviceToken(app, code).pipe(Effect.provide(expired.layer), Effect.flip, Effect.forkChild);
      const second = yield* pollDeviceToken(app, code).pipe(Effect.provide(declined.layer), Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("5 seconds");

      assert.include((yield* Fiber.join(first)).message, "期限");
      assert.include((yield* Fiber.join(second)).message, "断られた");
    }));
});

describe("refreshTokens", () => {
  it.effect("リフレッシュトークンで、新しいアクセストークンと（入れ替わった）リフレッシュトークンを取る", () =>
    Effect.gen(function* () {
      const { requests, layer } = fakeLogin([{ body: { ...tokens, access_token: "at-2", refresh_token: "rt-2" } }]);

      const result = yield* refreshTokens(app, Redacted.make("rt-1")).pipe(Effect.provide(layer));

      assert.strictEqual(requests[0]?.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
      assert.strictEqual(requests[0]?.form.get("grant_type"), "refresh_token");
      assert.strictEqual(requests[0]?.form.get("refresh_token"), "rt-1");
      assert.strictEqual(requests[0]?.form.get("scope"), "offline_access User.Read Calendars.Read");
      assert.deepStrictEqual([Redacted.value(result.accessToken), Redacted.value(result.refreshToken)], ["at-2", "rt-2"]);
    }));

  it.effect("リフレッシュトークンが無効なら、サインインし直すよう促す失敗にする（トークンは含めない）", () =>
    Effect.gen(function* () {
      const { layer } = fakeLogin([{ status: 400, body: { error: "invalid_grant", error_description: "AADSTS70043: The refresh token has expired" } }]);

      const error = yield* refreshTokens(app, Redacted.make("rt-secret")).pipe(Effect.provide(layer), Effect.flip);

      assert.include(error.message, "サインインし直して");
      assert.notInclude(error.message, "rt-secret");
    }));
});
