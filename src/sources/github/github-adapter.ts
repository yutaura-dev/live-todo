import { Context, DateTime, Effect, Option, Schema } from "effect";
import type { SourceAdapter } from "../../core/sync/source-adapter.js";
import type { SourceChange } from "../../core/sync/source-change.js";
import { makeRepositoryFilter, type RepositoryFilterConfig } from "./repository-filter.js";

export class GitHubRequestError extends Schema.TaggedError<GitHubRequestError>()("GitHubRequestError", {
  message: Schema.String,
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
  listNotifications(params: { since: string; all: boolean }): Effect.Effect<unknown, GitHubClientError>;
  /** 対象が削除された・見られなくなったときは Option.none を返す */
  getSubject(apiUrl: string): Effect.Effect<Option.Option<unknown>, GitHubClientError>;
  /** 自分が author の open な PR（Search API: is:pr is:open author:@me） */
  readonly searchMyOpenPullRequests: Effect.Effect<unknown, GitHubClientError>;
  /** 対象が削除された・見られなくなったときは Option.none を返す */
  getPullRequest(apiUrl: string): Effect.Effect<Option.Option<unknown>, GitHubClientError>;
  listCheckRuns(repository: string, sha: string): Effect.Effect<unknown, GitHubClientError>;
  listReviews(pullApiUrl: string): Effect.Effect<unknown, GitHubClientError>;
}>()("live-todo/sources/github/GitHubClient") {}

const GitHubNotification = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
  updated_at: Schema.String,
  subject: Schema.Struct({ title: Schema.String, url: Schema.NullOr(Schema.String), type: Schema.String }),
  repository: Schema.Struct({ full_name: Schema.String, html_url: Schema.String }),
});
type GitHubNotification = typeof GitHubNotification.Type;

const GitHubSubjectDetail = Schema.Struct({
  state: Schema.String,
  merged: Schema.optional(Schema.Boolean),
  html_url: Schema.String,
});
type GitHubSubjectDetail = typeof GitHubSubjectDetail.Type;

export const decodeResponse = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (input: unknown) =>
    decode(input).pipe(Effect.mapError((error) => new GitHubResponseError({ message: error.message })));
};
const decodeNotifications = decodeResponse(Schema.Array(GitHubNotification));
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
};

export type GitHubCursor = { since: string };

export type GitHubAdapterOptions = {
  initialLookbackDays: number;
  repositoryFilter?: RepositoryFilterConfig;
};

export type GitHubAdapterError = GitHubClientError | GitHubResponseError;

const RULE_TODO_REASONS = new Set(["review_requested", "assign", "ci_activity"]);

// GitHub の API レート制限（認証済みで 1 時間あたり 5,000 リクエスト）を同期 1 回で使い切らないよう、同時実行数を絞る。
const SUBJECT_FETCH_CONCURRENCY = 5;

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

    return {
      kind: "upserted",
      item: { ...base, externalId: apiUrl, htmlUrl: detail.html_url, state: stateOf(detail) },
    } satisfies SourceChange<GitHubItem>;
  });

  const adapter: SourceAdapter<GitHubItem, GitHubCursor, GitHubAdapterError> = {
    fetchChanges: (cursor) =>
      Effect.gen(function* () {
        const since =
          cursor?.since ?? DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: options.initialLookbackDays }));
        // all: true にする理由: 既定の未読のみだと、GitHub の Web で通知を開いて既読にした後の
        // マージ・クローズなどの状態変化が取れなくなるため。
        const notifications = yield* client.listNotifications({ since, all: true }).pipe(Effect.flatMap(decodeNotifications));

        const targets = notifications.filter((notification) => isTargetRepository(notification.repository.full_name));
        const changes = yield* Effect.forEach(targets, toChange, { concurrency: SUBJECT_FETCH_CONCURRENCY });

        // フィルター後の targets ではなく全通知からカーソルを作る理由:
        // 除外したリポジトリの通知が最新のとき、カーソルが進まず毎回取得し直すことになるため。
        return { changes, nextCursor: { since: latestUpdatedAt(notifications) ?? since } };
      }),
  };
  return adapter;
});

function stateOf(detail: GitHubSubjectDetail): GitHubItemState {
  if (detail.merged === true) return "merged";
  if (detail.state === "open" || detail.state === "closed") return detail.state;
  return "unknown";
}

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
