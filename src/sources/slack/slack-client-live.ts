import { DateTime, Effect, Layer, Option, Redacted, Ref, Schema, Semaphore } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import { SlackClient, type SlackClientError, SlackRateLimitedError, SlackRequestError } from "./slack-client.js";

export type SlackClientLiveOptions = {
  /** ワークスペースのドメイン（acme.slack.com） */
  workspace: string;
  /** xoxc- のトークン */
  token: Redacted.Redacted<string>;
  /** d の Cookie（xoxd-） */
  cookie: Redacted.Redacted<string>;
  /** セッションを取ったブラウザの User-Agent。違うと全端末のログアウトを招くことがある（ADR-0010） */
  userAgent: string;
  /** リクエストの間隔。公式の Tier 2（毎分 20 回程度）に収める */
  minIntervalMs?: number;
};

const DEFAULT_MIN_INTERVAL_MS = 3000;
const SAVED_PAGE_SIZE = "50";
// Web クライアントが全リクエストに付けている項目。必須かは分からないが、付けておく（仕様書）
const WEB_CLIENT_FIELDS = { _x_mode: "online", _x_sonic: "true", _x_app_name: "client" };
const SESSION_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive"]);

const Envelope = Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) });
const SavedListBody = Schema.Struct({
  saved_items: Schema.Array(Schema.Unknown),
  counts: Schema.optional(Schema.Struct({ total_count: Schema.optional(Schema.Number) })),
  response_metadata: Schema.optional(Schema.Struct({ next_cursor: Schema.optional(Schema.String) })),
});
const MessagesBody = Schema.Struct({
  messages: Schema.optional(Schema.Array(Schema.Struct({ ts: Schema.String, text: Schema.optional(Schema.String), user: Schema.optional(Schema.String) }))),
});
const AuthTestBody = Schema.Struct({ user_id: Schema.String, user: Schema.String, team: Schema.String });

export const isSlackWorkspace = (domain: string) => /^[a-z0-9][a-z0-9-]*(\.enterprise)?\.slack\.com$/.test(domain);

export const SlackClientLive = (options: SlackClientLiveOptions) =>
  Layer.effect(
    SlackClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const origin = `https://${options.workspace}`;
      // 1 本ずつ、間隔を空けて送る。非公開 API の制限は分からないので、公式の Tier 2 相当に抑える
      const queue = yield* Semaphore.make(1);
      const lastSentAt = yield* Ref.make(0);
      const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

      const call = <S extends Schema.Top>(method: string, params: Record<string, string>, schema: S, reason?: string) =>
        Semaphore.withPermits(
          queue,
          1,
          Effect.gen(function* () {
            if (!isSlackWorkspace(options.workspace)) {
              return yield* new SlackRequestError({ message: `Slack のワークスペースのドメインではない: ${options.workspace}` });
            }
            const wait = (yield* Ref.get(lastSentAt)) + minInterval - DateTime.toEpochMillis(yield* DateTime.now);
            if (wait > 0) yield* Effect.sleep(wait);
            yield* Ref.set(lastSentAt, DateTime.toEpochMillis(yield* DateTime.now));

            const body = new URLSearchParams({
              token: Redacted.value(options.token),
              ...WEB_CLIENT_FIELDS,
              ...(reason === undefined ? {} : { _x_reason: reason }),
              ...params,
            });
            const request = HttpClientRequest.post(`${origin}/api/${method}`).pipe(
              HttpClientRequest.setHeader("cookie", `d=${encodeURIComponent(Redacted.value(options.cookie))}`),
              HttpClientRequest.setHeader("origin", "https://app.slack.com"),
              HttpClientRequest.setHeader("user-agent", options.userAgent),
              HttpClientRequest.bodyText(body.toString(), "application/x-www-form-urlencoded"),
            );
            const response = yield* http.execute(request).pipe(
              // 元のエラーを入れない理由: 送ったリクエスト（トークンと Cookie）を持っていて、ログに出すと漏れるため
              Effect.mapError((error) => new SlackRequestError({ message: `Slack に接続できない（${error.reason._tag}）: ${method}` })),
            );
            const json = yield* response.json.pipe(Effect.orElseSucceed(() => ({}) as unknown));
            const envelope = Option.getOrUndefined(Schema.decodeUnknownOption(Envelope)(json));
            if (response.status === 429 || envelope?.error === "ratelimited") {
              const retryAfter = Number.parseInt(Option.getOrElse(Headers.get(response.headers, "retry-after"), () => "60"), 10) || 60;
              return yield* new SlackRateLimitedError({ resetAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: retryAfter })) });
            }
            if (envelope === undefined || !envelope.ok) {
              const code = envelope?.error ?? `HTTP ${response.status}`;
              const hint = SESSION_ERRORS.has(code) ? "。Slack のセッションが切れたか、Cookie が合っていない。設定画面でトークンと Cookie を入れ直してください" : "";
              return yield* new SlackRequestError({ message: `Slack API（${method}）が失敗した: ${code}${hint}`, error: code });
            }
            return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
              Effect.mapError((error) => new SlackRequestError({ message: `Slack API（${method}）の応答の形が想定と違う: ${error.message}` })),
            );
          }),
        ) as Effect.Effect<S["Type"], SlackClientError>;

      const message = Effect.fnUntraced(function* (channel: string, ts: string) {
        const history = yield* call(
          "conversations.history",
          { channel, latest: ts, oldest: ts, inclusive: "true", limit: "1" },
          MessagesBody,
        );
        const found = history.messages?.find((candidate) => candidate.ts === ts);
        // スレッドの返信は history に出ないので、replies で探す（仕様書）
        const reply = found ?? (yield* call("conversations.replies", { channel, ts, limit: "200" }, MessagesBody)).messages?.find((candidate) => candidate.ts === ts);
        return reply === undefined ? Option.none() : Option.some({ text: reply.text ?? "", user: reply.user });
      });

      return SlackClient.of({
        savedList: ({ filter, cursor }) =>
          call(
            "saved.list",
            {
              limit: SAVED_PAGE_SIZE,
              include_tombstones: "true",
              ...(filter === undefined ? {} : { filter }),
              ...(cursor === undefined ? {} : { cursor }),
            },
            SavedListBody,
            "saved-api/savedList",
          ).pipe(
            Effect.map((body) => ({
              items: body.saved_items,
              nextCursor: body.response_metadata?.next_cursor ?? "",
              totalCount: body.counts?.total_count,
            })),
          ),
        message,
        authTest: call("auth.test", {}, AuthTestBody).pipe(Effect.map((body) => ({ userId: body.user_id, user: body.user, team: body.team }))),
      });
    }),
  );
