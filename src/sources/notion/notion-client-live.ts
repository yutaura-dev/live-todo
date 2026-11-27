import { DateTime, Effect, Layer, Option, Redacted, Ref, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { NotionClient, type NotionClientError, NotionRateLimitedError, NotionRequestError } from "./notion-client.js";
import { unwrapRecordMap } from "./notion-records.js";

export const NOTION_ORIGINS = ["https://www.notion.so", "https://app.notion.com"] as const;
export type NotionOrigin = (typeof NOTION_ORIGINS)[number];

export type NotionClientLiveOptions = {
  /** Cookie の token_v2 */
  token: Redacted.Redacted<string>;
  /** Cookie の notion_user_id（自分のユーザー ID） */
  userId: string;
  /** セッションを取ったブラウザの User-Agent（ADR-0015） */
  userAgent: string;
  origin?: NotionOrigin;
  /** リクエストの間隔。非公開 API の制限は分からないので、控えめにする */
  minIntervalMs?: number;
};

const DEFAULT_MIN_INTERVAL_MS = 1000;
// 429 に Retry-After はほぼ付かず、一度受けるとしばらく続く（notion-client の retry.ts）
const RATE_LIMIT_PAUSE_SECONDS = 60;
const SESSION_STATUSES = new Set([401, 403]);

const ErrorBody = Schema.Struct({ name: Schema.optional(Schema.String) });
const AnyRecord = Schema.Record(Schema.String, Schema.Unknown);
const SpacesBody = Schema.Record(
  Schema.String,
  Schema.Struct({ notion_user: Schema.optional(AnyRecord), space: Schema.optional(AnyRecord) }),
);
const NotificationLogBody = Schema.Struct({ notificationIds: Schema.Array(Schema.String), recordMap: Schema.optional(AnyRecord) });
const Named = Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String) });
const decodeNamed = Schema.decodeUnknownOption(Named);

export const NotionClientLive = (options: NotionClientLiveOptions) =>
  Layer.effect(
    NotionClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const origin = options.origin ?? "https://www.notion.so";
      const queue = yield* Semaphore.make(1);
      const lastSentAt = yield* Ref.make(0);
      const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

      const call = <S extends Schema.Top>(method: string, body: object, schema: S, spaceId?: string) =>
        Semaphore.withPermits(
          queue,
          1,
          Effect.gen(function* () {
            const wait = (yield* Ref.get(lastSentAt)) + minInterval - DateTime.toEpochMillis(yield* DateTime.now);
            if (wait > 0) yield* Effect.sleep(wait);
            yield* Ref.set(lastSentAt, DateTime.toEpochMillis(yield* DateTime.now));

            const base = HttpClientRequest.post(`${origin}/api/v3/${method}`).pipe(
              HttpClientRequest.setHeader("cookie", `token_v2=${Redacted.value(options.token)}; notion_user_id=${options.userId}`),
              HttpClientRequest.setHeader("x-notion-active-user-header", options.userId),
            );
            const request = (spaceId === undefined ? base : HttpClientRequest.setHeader(base, "x-notion-space-id", spaceId)).pipe(
              HttpClientRequest.setHeader("notion-audit-log-platform", "web"),
              HttpClientRequest.setHeader("origin", origin),
              HttpClientRequest.setHeader("user-agent", options.userAgent),
              HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
            );
            const response = yield* http.execute(request).pipe(
              // 元のエラーを入れない理由: 送ったリクエスト（Cookie）を持っていて、ログに出すと漏れるため
              Effect.mapError((error) => new NotionRequestError({ message: `Notion に接続できない（${error.reason._tag}）: ${method}` })),
            );
            if (response.status === 429) {
              return yield* new NotionRateLimitedError({ resetAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: RATE_LIMIT_PAUSE_SECONDS })) });
            }
            const json = yield* response.json.pipe(Effect.option);
            if (response.status < 200 || response.status >= 300) {
              const name = Option.flatMap(json, Schema.decodeUnknownOption(ErrorBody)).pipe(
                Option.flatMap((body) => Option.fromNullishOr(body.name)),
                Option.getOrElse(() => `HTTP ${response.status}`),
              );
              const hint = SESSION_STATUSES.has(response.status) ? "。Notion のセッションが切れた。設定画面でログインし直してください" : "";
              return yield* new NotionRequestError({ message: `Notion API（${method}）が失敗した: ${name}${hint}`, status: response.status });
            }
            if (Option.isNone(json)) {
              return yield* new NotionRequestError({ message: `Notion API（${method}）の応答が JSON でない（確認のページが返った可能性がある）`, status: response.status });
            }
            return yield* Schema.decodeUnknownEffect(schema)(json.value).pipe(
              Effect.mapError((error) => new NotionRequestError({ message: `Notion API（${method}）の応答の形が想定と違う: ${error.message}` })),
            );
          }),
        ) as Effect.Effect<S["Type"], NotionClientError>;

      return NotionClient.of({
        me: call("getSpaces", {}, SpacesBody).pipe(
          Effect.flatMap((body) => {
            const mine = body[options.userId];
            if (mine === undefined) return Effect.fail(new NotionRequestError({ message: "Notion のセッションの持ち主が、設定のユーザーと違う。ログインし直してください" }));
            const user = Option.flatMap(Option.fromNullishOr(unwrapRecordMap({ notion_user: mine.notion_user ?? {} })["notion_user"]?.[options.userId]), decodeNamed);
            const spaces = Object.values(unwrapRecordMap({ space: mine.space ?? {} })["space"] ?? {}).flatMap((record) =>
              Option.match(decodeNamed(record), { onNone: () => [], onSome: (space) => [{ id: space.id, name: space.name ?? "" }] }),
            );
            return Effect.succeed({ userId: options.userId, name: Option.match(user, { onNone: () => "", onSome: (found) => found.name ?? "" }), spaces });
          }),
        ),
        notifications: (spaceId, size) =>
          call("getNotificationLogV2", { spaceId, size, type: "unread_and_read", variant: "no_grouping" }, NotificationLogBody, spaceId).pipe(
            Effect.map((body) => ({ notificationIds: body.notificationIds, recordMap: unwrapRecordMap(body.recordMap ?? {}) })),
          ),
      });
    }),
  );
