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
const UserBody = Schema.Struct({
  user: Schema.Struct({
    name: Schema.String,
    real_name: Schema.optional(Schema.String),
    profile: Schema.optional(Schema.Struct({ display_name: Schema.optional(Schema.String) })),
  }),
});
const ChannelBody = Schema.Struct({
  channel: Schema.Struct({ name: Schema.optional(Schema.String), is_im: Schema.optional(Schema.Boolean), is_mpim: Schema.optional(Schema.Boolean) }),
});
// 見られないものは失敗ではなく「なし」として扱う
const NOT_VISIBLE = new Set(["channel_not_found", "user_not_found", "not_in_channel", "missing_scope"]);
const OkBody = Schema.Struct({ ok: Schema.Boolean });
const UserGroupsBody = Schema.Struct({
  usergroups: Schema.Array(Schema.Struct({ id: Schema.String, handle: Schema.String, users: Schema.optional(Schema.Array(Schema.String)) })),
});
const SearchBody = Schema.Struct({
  messages: Schema.Struct({
    total: Schema.Number,
    paging: Schema.optional(Schema.Struct({ pages: Schema.optional(Schema.Number) })),
    matches: Schema.Array(
      Schema.Struct({
        channel: Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String), is_im: Schema.optional(Schema.Boolean), is_mpim: Schema.optional(Schema.Boolean) }),
        ts: Schema.String,
        text: Schema.optional(Schema.String),
        user: Schema.optional(Schema.String),
        permalink: Schema.optional(Schema.String),
      }),
    ),
  }),
});
// 検索の結果には thread_ts がないので、permalink の thread_ts から読む
const threadTsOf = (permalink: string | undefined) =>
  permalink !== undefined && URL.canParse(permalink) ? (new URL(permalink).searchParams.get("thread_ts") ?? undefined) : undefined;
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

      const orNone = <A>(effect: Effect.Effect<A, SlackClientError>) =>
        effect.pipe(
          Effect.map(Option.some),
          Effect.catchTag("SlackRequestError", (error) => (error.error !== undefined && NOT_VISIBLE.has(error.error) ? Effect.succeed(Option.none<A>()) : Effect.fail(error))),
        );

      return SlackClient.of({
        // 仕様書のとおり、Web クライアントが実際に送っていた組み合わせだけを送る（ほかの組み合わせは動作が確かめられていない）
        completeSaved: (channel, ts) =>
          call(
            "saved.update",
            { item_type: "message", item_id: channel, ts, mark: "completed", todo_state: "completed", date_due: "0" },
            OkBody,
            "saved-api/updateSavedMessage",
          ).pipe(Effect.asVoid),
        removeSaved: (channel, ts) => call("saved.delete", { item_type: "message", item_id: channel, ts }, OkBody).pipe(Effect.asVoid),
        searchMessages: (query, page = 1) =>
          call("search.messages", { query, sort: "timestamp", sort_dir: "desc", count: "100", page: String(page) }, SearchBody).pipe(
            Effect.map((body) => ({
              total: body.messages.total,
              pages: body.messages.paging?.pages ?? 1,
              matches: body.messages.matches.map((match) => ({
                channel: match.channel.id,
                channelName: match.channel.name ?? "",
                isDirect: match.channel.is_im === true || match.channel.is_mpim === true,
                ts: match.ts,
                threadTs: threadTsOf(match.permalink),
                user: match.user,
                text: match.text ?? "",
              })),
            })),
          ),
        myUserGroups: (userId) =>
          call("usergroups.list", { include_users: "true" }, UserGroupsBody).pipe(
            Effect.map((body) => body.usergroups.filter((group) => group.users?.includes(userId) === true).map((group) => ({ id: group.id, handle: group.handle }))),
          ),
        userName: (userId) =>
          orNone(call("users.info", { user: userId }, UserBody)).pipe(
            Effect.map(Option.map((body) => body.user.profile?.display_name || body.user.real_name || body.user.name)),
          ),
        channel: (channelId) =>
          orNone(call("conversations.info", { channel: channelId }, ChannelBody)).pipe(
            Effect.map(Option.map((body) => ({ name: body.channel.name ?? "", isDirect: body.channel.is_im === true || body.channel.is_mpim === true }))),
          ),
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
