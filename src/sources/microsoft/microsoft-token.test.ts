import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { MicrosoftToken, MicrosoftTokenLive } from "./microsoft-token.js";

const app = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", scopes: ["offline_access", "User.Read"] };

const setup = (stored: string | undefined) => {
  let issued = 0;
  const saved: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      issued++;
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ access_token: `at-${issued}`, refresh_token: `rt-${issued + 1}`, expires_in: 3600 }), { headers: { "content-type": "application/json" } }),
      );
    }),
  );
  const layer = MicrosoftTokenLive({
    ...app,
    loadRefreshToken: Effect.sync(() => Option.fromNullishOr(saved.at(-1) ?? stored).pipe(Option.map(Redacted.make))),
    saveRefreshToken: (token) => Effect.sync(() => void saved.push(Redacted.value(token))),
  }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));
  return { layer, saved, issuedCount: () => issued };
};

const accessToken = Effect.gen(function* () {
  return Redacted.value(yield* (yield* MicrosoftToken).accessToken);
});

describe("MicrosoftTokenLive", () => {
  it.effect("保存したリフレッシュトークンでアクセストークンを取り、入れ替わったリフレッシュトークンを保存する。期限の 5 分前までは使い回す", () =>
    Effect.gen(function* () {
      const { layer, saved, issuedCount } = setup("rt-1");

      yield* Effect.gen(function* () {
        assert.strictEqual(yield* accessToken, "at-1");
        yield* TestClock.adjust("54 minutes");
        assert.strictEqual(yield* accessToken, "at-1");
        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(yield* accessToken, "at-2");
      }).pipe(Effect.provide(layer));

      assert.strictEqual(issuedCount(), 2);
      assert.deepStrictEqual(saved, ["rt-2", "rt-3"]);
    }));

  it.effect("invalidate したら、期限の前でも取り直す（401 が返ったとき）", () =>
    Effect.gen(function* () {
      const { layer } = setup("rt-1");

      yield* Effect.gen(function* () {
        yield* accessToken;
        yield* (yield* MicrosoftToken).invalidate;
        assert.strictEqual(yield* accessToken, "at-2");
      }).pipe(Effect.provide(layer));
    }));

  it.effect("リフレッシュトークンがなければ、サインインを促す失敗にする", () =>
    Effect.gen(function* () {
      const { layer } = setup(undefined);

      const error = yield* accessToken.pipe(Effect.provide(layer), Effect.flip);

      assert.strictEqual(error._tag, "MicrosoftAuthError");
      assert.include(error.message, "サインイン");
    }));
});
