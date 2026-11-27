import { Context, DateTime, Effect, Layer, Option, type Redacted, Ref, Semaphore } from "effect";
import { HttpClient } from "effect/http";
import { MicrosoftAuthError, type MicrosoftApp, refreshTokens } from "./microsoft-auth.js";

/** Graph に送るアクセストークン。期限が近づいたら、保存したリフレッシュトークンで取り直す */
export class MicrosoftToken extends Context.Service<MicrosoftToken, {
  readonly accessToken: Effect.Effect<Redacted.Redacted<string>, MicrosoftAuthError>;
  /** 401 が返ったときに、期限の前でも次は取り直すようにする */
  readonly invalidate: Effect.Effect<void>;
}>()("live-todo/sources/microsoft/MicrosoftToken") {}

// 期限ちょうどまで使うと、送っている途中で切れることがあるので、少し前に取り直す
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const MicrosoftTokenLive = (
  options: MicrosoftApp & {
    loadRefreshToken: Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
    saveRefreshToken: (token: Redacted.Redacted<string>) => Effect.Effect<void>;
  },
) =>
  Layer.effect(
    MicrosoftToken,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const cached = yield* Ref.make(Option.none<{ token: Redacted.Redacted<string>; renewAt: number }>());
      // 同時に取り直すと、入れ替わる前のリフレッシュトークンを 2 回使ってしまうので、1 本ずつにする
      const lock = yield* Semaphore.make(1);

      const accessToken = Semaphore.withPermits(
        lock,
        1,
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const current = yield* Ref.get(cached);
          if (Option.isSome(current) && current.value.renewAt > now) return current.value.token;
          const stored = yield* options.loadRefreshToken;
          if (Option.isNone(stored)) return yield* new MicrosoftAuthError({ message: "Microsoft にサインインしていない。設定画面でサインインしてください" });
          const tokens = yield* refreshTokens(options, stored.value).pipe(Effect.provideService(HttpClient.HttpClient, http));
          yield* options.saveRefreshToken(tokens.refreshToken);
          yield* Ref.set(cached, Option.some({ token: tokens.accessToken, renewAt: now + tokens.expiresInSeconds * 1000 - REFRESH_MARGIN_MS }));
          return tokens.accessToken;
        }),
      );

      return MicrosoftToken.of({ accessToken, invalidate: Ref.set(cached, Option.none()) });
    }),
  );
