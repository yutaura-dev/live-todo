import { Context, DateTime, Effect, Option, Schema } from "effect";
import type { SourceAdapter } from "../../core/sync/source-adapter.js";
import type { SourceChange } from "../../core/sync/source-change.js";
import { makeRepositoryFilter, type RepositoryFilterConfig } from "./repository-filter.js";

export class GitHubRequestError extends Schema.TaggedError<GitHubRequestError>()("GitHubRequestError", {
  message: Schema.String,
  /** HTTP のステータス。接続そのものに失敗したときは undefined */
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class GitHubResponseError extends Schema.TaggedError<GitHubResponseError>()("GitHubResponseError", {
  message: Schema.String,
}) {}

/** レート制限にかかった。resetAt（ISO 8601）まで、そのアカウントの同期を休む */
export class GitHubRateLimitedError extends Schema.TaggedError<GitHubRateLimitedError>()("GitHubRateLimitedError", {
  resetAt: Schema.String,
}) {}

export type GitHubClientError = GitHubRequestError | GitHubRateLimitedError;

export class GitHubClient extends Context.Service<GitHubClient, {
  /** truncated: ページ数の上限で打ち切り、取り残した古い通知がある */
  listNotifications(params: { since: string; before?: string; all: boolean }): Effect.Effect<
    { notifications: unknown; truncated: boolean },
    GitHubClientError
  >;
  /** 対象が削除された・見られなくなったときは Option.none を返す */
  getSubject(apiUrl: string): Effect.Effect<Option.Option<unknown>, GitHubClientError>;
  /** 自分が author の open な PR（Search API: is:pr is:open author:@me） */
  readonly searchMyOpenPullRequests: Effect.Effect<unknown, GitHubClientError>;
  /** 通知の latest_comment_url が指すコメント。見つからなければ Option.none */
  getComment(apiUrl: string): Effect.Effect<Option.Option<unknown>, GitHubClientError>;
  /** トークンの持ち主（自分）のアカウント */
  readonly getViewer: Effect.Effect<unknown, GitHubClientError>;
  /** 対象が削除された・見られなくなったときは Option.none を返す */
  getPullRequest(apiUrl: string): Effect.Effect<Option.Option<unknown>, GitHubClientError>;
  listCheckRuns(repository: string, sha: string): Effect.Effect<unknown, GitHubClientError>;
  listReviews(pullApiUrl: string): Effect.Effect<unknown, GitHubClientError>;
}>()("live-todo/sources/github/GitHubClient") {}

export const GitHubNotificationSchema = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
  updated_at: Schema.String,
  subject: Schema.Struct({
    title: Schema.String,
    url: Schema.NullOr(Schema.String),
    type: Schema.String,
    latest_comment_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  repository: Schema.Struct({ full_name: Schema.String, html_url: Schema.String }),
});
export type GitHubNotification = typeof GitHubNotificationSchema.Type;

const GitHubSubjectDetail = Schema.Struct({
  state: Schema.String,
  merged: Schema.optional(Schema.Boolean),
  html_url: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
});
type GitHubSubjectDetail = typeof GitHubSubjectDetail.Type;

export const decodeResponse = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (input: unknown) =>
    decode(input).pipe(Effect.mapError((error) => new GitHubResponseError({ message: error.message })));
};
const decodeNotifications = decodeResponse(Schema.Array(GitHubNotificationSchema));
const decodeSubjectDetail = decodeResponse(GitHubSubjectDetail);

export type GitHubItemState = "open" | "closed" | "merged" | "unknown";

export type GitHubItem = {
  externalId: string;
  reason: string;
  subjectType: string;
  title: string;
  repository: string;
  htmlUrl: string;
  state: GitHubItemState;
  updatedAt: string;
  /** 以下は LLM に判定を頼むときの材料 */
  author?: string;
  bodyExcerpt?: string;
  latestCommentUrl?: string;
};

// LLM に渡す本文を冒頭に絞る理由: 判定には冒頭で足りることが多く、長い PR の説明をそのまま渡すと料金が増えるため。
export const BODY_EXCERPT_LENGTH = 1000;

/**
 * backfill: 前回の取得がページ数の上限で打ち切られ、since から before までの古い通知を取り残している。
 * 取り切ったら newest（打ち切られた最初の取得で一番新しかった時刻）から通常の差分取得に戻る。
 */
export type GitHubCursor = {
  since: string;
  backfill?: { before: string; newest: string };
  /** PR / issue の取得に失敗し、次の同期で取り直す通知 */
  retry?: ReadonlyArray<RetryEntry>;
};

export type RetryEntry = { notification: GitHubNotification; firstFailedAt: string };

// 回数ではなく最初の失敗からの時間で諦める理由: 同期は 1 分ごとに回るので、回数で区切ると
// GitHub の数分の障害で通知を捨ててしまう。
const RETRY_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

export type GitHubAdapterOptions = {
  initialLookbackDays: number;
  repositoryFilter?: RepositoryFilterConfig;
};

export type GitHubAdapterError = GitHubClientError | GitHubResponseError;

const RULE_TODO_REASONS = new Set(["review_requested", "assign", "ci_activity"]);


export const githubTodoRules: readonly ((item: GitHubItem) => boolean)[] = [
  (item) => RULE_TODO_REASONS.has(item.reason) && item.state !== "closed" && item.state !== "merged",
];

export const makeGitHubAdapter = Effect.fnUntraced(function* (options: GitHubAdapterOptions) {
  const client = yield* GitHubClient;
  const isTargetRepository = yield* makeRepositoryFilter(options.repositoryFilter ?? {});

  const toChange = Effect.fnUntraced(function* (notification: GitHubNotification) {
    const base = {
      reason: notification.reason,
      subjectType: notification.subject.type,
      title: notification.subject.title,
      repository: notification.repository.full_name,
      updatedAt: notification.updated_at,
    };

    const apiUrl = notification.subject.url;
    if (apiUrl === null) {
      return {
        kind: "upserted",
        item: { ...base, externalId: `github:thread:${notification.id}`, htmlUrl: notification.repository.html_url, state: "unknown" },
      } satisfies SourceChange<GitHubItem>;
    }

    const raw = yield* client.getSubject(apiUrl);
    if (Option.isNone(raw)) {
      return { kind: "removed", externalId: apiUrl } satisfies SourceChange<GitHubItem>;
    }
    const detail = yield* decodeSubjectDetail(raw.value);
    const latestCommentUrl = notification.subject.latest_comment_url;

    return {
      kind: "upserted",
      item: {
        ...base,
        externalId: apiUrl,
        htmlUrl: detail.html_url,
        state: stateOf(detail),
        ...(detail.user == null ? {} : { author: detail.user.login }),
        ...(detail.body == null || detail.body === "" ? {} : { bodyExcerpt: detail.body.slice(0, BODY_EXCERPT_LENGTH) }),
        // 新しい PR の通知では latest_comment_url が対象そのものを指す（コメントがまだない）ので持たせない
        ...(latestCommentUrl == null || latestCommentUrl === apiUrl ? {} : { latestCommentUrl }),
      },
    } satisfies SourceChange<GitHubItem>;
  });

  const adapter: SourceAdapter<GitHubItem, GitHubCursor, GitHubAdapterError> = {
    fetchChanges: (cursor) =>
      Effect.gen(function* () {
        const since =
          cursor?.since ?? DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: options.initialLookbackDays }));
        const backfill = cursor?.backfill;
        // all: true にする理由: 既定の未読のみだと、GitHub の Web で通知を開いて既読にした後の
        // マージ・クローズなどの状態変化が取れなくなるため。
        const response = yield* client.listNotifications(
          backfill === undefined ? { since, all: true } : { since, before: backfill.before, all: true },
        );
        const notifications = yield* decodeNotifications(response.notifications);

        const now = yield* DateTime.now;
        const freshIds = new Set(notifications.map((notification) => notification.id));
        // 新しい取得にも含まれている通知は、新しいほうだけを使う（同じ通知を 2 回取りに行かない）
        const previousRetries = (cursor?.retry ?? []).filter((entry) => !freshIds.has(entry.notification.id));
        const firstFailedAtOf = new Map(previousRetries.map((entry) => [entry.notification.id, entry.firstFailedAt]));

        const targets = [...previousRetries.map((entry) => entry.notification), ...notifications].filter((notification) =>
          isTargetRepository(notification.repository.full_name),
        );
        const outcomes = yield* Effect.forEach(targets, (notification) =>
          toChange(notification).pipe(
            Effect.map((change) => ({ ok: true as const, change })),
            // HTTP のステータスがある失敗だけを 1 件ごとの保留にする理由: 接続そのものの失敗は全件で起きるので、
            // 保留にすると同期が成功扱いでカーソルだけ進み、障害が長引くとまとめて諦めることになるため。
            Effect.catchTags({
              GitHubRequestError: (error) =>
                error.status === undefined ? Effect.fail(error) : Effect.succeed({ ok: false as const, notification, error }),
              GitHubResponseError: (error) => Effect.succeed({ ok: false as const, notification, error }),
            }),
          ),
        );

        const changes = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.change] : []));
        const retry: RetryEntry[] = [];
        for (const outcome of outcomes) {
          if (outcome.ok) continue;
          const firstFailedAt = firstFailedAtOf.get(outcome.notification.id) ?? DateTime.formatIso(now);
          const failingFor = Option.match(DateTime.make(firstFailedAt), {
            onNone: () => 0,
            onSome: (since) => DateTime.toEpochMillis(now) - DateTime.toEpochMillis(since),
          });
          if (failingFor >= RETRY_GIVE_UP_AFTER_MS) {
            yield* Effect.logError("通知の対象を 24 時間取得できなかったため、取り直すのを諦める").pipe(
              Effect.annotateLogs({ notification: outcome.notification.id, reason: outcome.error.message }),
            );
            continue;
          }
          yield* Effect.logWarning("通知の対象を取得できなかったため、次の同期で取り直す").pipe(
            Effect.annotateLogs({ notification: outcome.notification.id, reason: outcome.error.message }),
          );
          retry.push({ notification: outcome.notification, firstFailedAt });
        }

        // フィルター後の targets ではなく全通知からカーソルを作る理由:
        // 除外したリポジトリの通知が最新のとき、カーソルが進まず毎回取得し直すことになるため。
        const nextCursor = nextCursorOf(since, backfill, notifications, response.truncated);
        return { changes, nextCursor: retry.length === 0 ? nextCursor : { ...nextCursor, retry } };
      }),
  };
  return adapter;
});

function stateOf(detail: GitHubSubjectDetail): GitHubItemState {
  if (detail.merged === true) return "merged";
  if (detail.state === "open" || detail.state === "closed") return detail.state;
  return "unknown";
}

// 通知は新しい順に返るので、打ち切られたときは取れた中で一番古い時刻より前が残っている。
// カーソルを一番新しい時刻に進めてしまうと、その残りを二度と取りに行かなくなるため、続きの範囲を覚えておく。
function nextCursorOf(
  since: string,
  backfill: GitHubCursor["backfill"],
  notifications: readonly GitHubNotification[],
  truncated: boolean,
): GitHubCursor {
  const oldest = oldestUpdatedAt(notifications);
  if (truncated && oldest !== undefined) {
    const newest = backfill?.newest ?? latestUpdatedAt(notifications) ?? since;
    return { since, backfill: { before: oldest, newest } };
  }
  if (backfill !== undefined) return { since: backfill.newest };
  return { since: latestUpdatedAt(notifications) ?? since };
}

function oldestUpdatedAt(notifications: readonly GitHubNotification[]): string | undefined {
  let oldest: GitHubNotification | undefined;
  for (const notification of notifications) {
    if (oldest === undefined || epochOfNotification(notification) < epochOfNotification(oldest)) oldest = notification;
  }
  return oldest?.updated_at;
}

const epochOfNotification = (notification: GitHubNotification) =>
  Option.match(DateTime.make(notification.updated_at), { onNone: () => Number.NEGATIVE_INFINITY, onSome: DateTime.toEpochMillis });

function latestUpdatedAt(notifications: readonly GitHubNotification[]): string | undefined {
  // 文字列比較で済ませない理由: GitHub は通常 Z 付きの同一形式で返すが、
  // 形式が揺れた場合に辞書順と時刻順がずれるため、時刻として比較する。
  const epochOf = (notification: GitHubNotification) =>
    Option.match(DateTime.make(notification.updated_at), { onNone: () => Number.NEGATIVE_INFINITY, onSome: DateTime.toEpochMillis });
  let latest: GitHubNotification | undefined;
  for (const notification of notifications) {
    if (latest === undefined || epochOf(notification) > epochOf(latest)) {
      latest = notification;
    }
  }
  return latest?.updated_at;
}
