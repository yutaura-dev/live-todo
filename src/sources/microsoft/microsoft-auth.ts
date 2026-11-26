import { Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export class MicrosoftAuthError extends Schema.TaggedError<MicrosoftAuthError>()("MicrosoftAuthError", {
  message: Schema.String,
  /** Microsoft が返した理由（invalid_grant など） */
  code: Schema.optional(Schema.String),
}) {}

/** Entra ID に登録したアプリと、求める権限 */
export type MicrosoftApp = { tenantId: string; clientId: string; scopes: ReadonlyArray<string> };

export type DeviceCode = {
  deviceCode: Redacted.Redacted<string>;
  /** ユーザーがサインインの画面に打ち込むコード */
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type TokenSet = { accessToken: Redacted.Redacted<string>; refreshToken: Redacted.Redacted<string>; expiresInSeconds: number };

const LOGIN_ORIGIN = "https://login.microsoftonline.com";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// slow_down を受けたら、間隔をこれだけ延ばす（RFC 8628 の 3.5）
const SLOW_DOWN_SECONDS = 5;

const DeviceCodeBody = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
});
const TokenBody = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.optional(Schema.String), expires_in: Schema.Number });
const ErrorBody = Schema.Struct({ error: Schema.String, error_description: Schema.optional(Schema.String) });

type Reply = { ok: true; json: unknown } | { ok: false; code: string; description: string };

const post = Effect.fnUntraced(function* (app: MicrosoftApp, endpoint: "devicecode" | "token", form: Record<string, string>) {
  const http = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(`${LOGIN_ORIGIN}/${encodeURIComponent(app.tenantId)}/oauth2/v2.0/${endpoint}`).pipe(
    HttpClientRequest.bodyText(new URLSearchParams({ client_id: app.clientId, ...form }).toString(), "application/x-www-form-urlencoded"),
  );
  // 元のエラーを入れない理由: 送ったフォーム（リフレッシュトークン）を持っていて、ログに出すと漏れるため
  const response = yield* http.execute(request).pipe(Effect.mapError((error) => new MicrosoftAuthError({ message: `Microsoft のサインインに接続できない（${error.reason._tag}）` })));
  const json = yield* response.json.pipe(Effect.orElseSucceed(() => ({}) as unknown));
  if (response.status >= 200 && response.status < 300) return { ok: true, json } satisfies Reply as Reply;
  const error = Option.getOrUndefined(Schema.decodeUnknownOption(ErrorBody)(json));
  return { ok: false, code: error?.error ?? `HTTP ${response.status}`, description: error?.error_description ?? "" } satisfies Reply as Reply;
});

const failWith = (reply: { code: string; description: string }, hint = "") =>
  new MicrosoftAuthError({ message: `Microsoft のサインインが失敗した: ${reply.code}${reply.description === "" ? "" : `（${reply.description.split("\n")[0]}）`}${hint}`, code: reply.code });

const decodeTokens = (json: unknown) =>
  Schema.decodeUnknownEffect(TokenBody)(json).pipe(
    Effect.mapError(() => new MicrosoftAuthError({ message: "Microsoft のサインインの応答の形が想定と違う" })),
    Effect.flatMap((body) =>
      body.refresh_token === undefined
        ? Effect.fail(new MicrosoftAuthError({ message: "リフレッシュトークンが返らなかった。アプリの権限に offline_access があるか確かめてください" }))
        : Effect.succeed({ accessToken: Redacted.make(body.access_token), refreshToken: Redacted.make(body.refresh_token), expiresInSeconds: body.expires_in } satisfies TokenSet),
    ),
  );

export const requestDeviceCode = Effect.fnUntraced(function* (app: MicrosoftApp) {
  const reply = yield* post(app, "devicecode", { scope: app.scopes.join(" ") });
  if (!reply.ok) return yield* failWith(reply, "。設定の client ID とテナント ID、アプリで「パブリック クライアント フローを許可する」が有効かを確かめてください");
  const body = yield* Schema.decodeUnknownEffect(DeviceCodeBody)(reply.json).pipe(
    Effect.mapError(() => new MicrosoftAuthError({ message: "Microsoft のサインインの応答の形が想定と違う" })),
  );
  return {
    deviceCode: Redacted.make(body.device_code),
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresInSeconds: body.expires_in,
    intervalSeconds: body.interval ?? 5,
  } satisfies DeviceCode;
});

/** ユーザーがサインインを済ませるまで、決められた間隔で問い合わせる。済んだらトークンを返す */
export const pollDeviceToken = Effect.fnUntraced(function* (app: MicrosoftApp, code: DeviceCode) {
  let interval = code.intervalSeconds;
  let waited = 0;
  while (waited < code.expiresInSeconds) {
    yield* Effect.sleep(`${interval} seconds`);
    waited += interval;
    const reply = yield* post(app, "token", { grant_type: DEVICE_CODE_GRANT, device_code: Redacted.value(code.deviceCode) });
    if (reply.ok) return yield* decodeTokens(reply.json);
    if (reply.code === "authorization_pending") continue;
    if (reply.code === "slow_down") {
      interval += SLOW_DOWN_SECONDS;
      continue;
    }
    if (reply.code === "expired_token") break;
    if (reply.code === "authorization_declined") return yield* new MicrosoftAuthError({ message: "サインインが断られた。もう一度サインインしてください", code: reply.code });
    return yield* failWith(reply);
  }
  return yield* new MicrosoftAuthError({ message: "コードの期限が切れた。もう一度サインインしてください", code: "expired_token" });
});

/** リフレッシュトークンで、新しいアクセストークンを取る。リフレッシュトークンも入れ替わるので、返った方を保存し直す */
export const refreshTokens = Effect.fnUntraced(function* (app: MicrosoftApp, refreshToken: Redacted.Redacted<string>) {
  const reply = yield* post(app, "token", { grant_type: "refresh_token", refresh_token: Redacted.value(refreshToken), scope: app.scopes.join(" ") });
  if (!reply.ok) return yield* failWith(reply, reply.code === "invalid_grant" ? "。設定画面で Microsoft にサインインし直してください" : "");
  return yield* decodeTokens(reply.json);
});
