import { DateTime, Effect, Option } from "effect";
import { SecretStore } from "../core/config/secret-store.js";
import type { SyncJob } from "../core/sync/scheduler.js";
import { syncSource } from "../core/sync/sync-source.js";
import { watchBinding } from "../core/watch/watch-binding.js";
import { type GitHubAdapterError, GitHubClient } from "../sources/github/github-adapter.js";
import { makeGitHubBinding } from "../sources/github/github-binding.js";
import { GitHubClientLive } from "../sources/github/github-client-live.js";
import { makeGitHubPullRequestWatchProvider, pullRequestConditions } from "../sources/github/github-watch.js";
import type { JudgeRequestError } from "../core/judge/todo-judge.js";
import type { ResolvedAccount } from "./config/app-config.js";

export const NOTIFICATION_SYNC_INTERVAL = "1 minute";
// 見張りの間隔を通知より長くする理由: 見張りは自分の open な PR ごとに 3 回（詳細・check・レビュー）API を呼ぶため。
export const WATCH_SYNC_INTERVAL = "5 minutes";

export type GitHubJobError = GitHubAdapterError | JudgeRequestError;

export const githubBackoffUntil = (error: GitHubJobError): Option.Option<DateTime.Utc> =>
  error._tag === "GitHubRateLimitedError" ? DateTime.make(error.resetAt) : Option.none();

export const makeGitHubJobs = Effect.fnUntraced(function* (account: ResolvedAccount) {
  const token = yield* (yield* SecretStore).require(`github.${account.id}.token`);

  // クライアントをアカウントごとに 1 つだけ作り、2 つのジョブで共有する理由: GitHubClientLive はトークンごとに
  // 1 本のキューとレート制限のブレーカーを持つので、ジョブごとに作るとキューが分かれて並行に送ってしまう。
  const client = yield* Effect.gen(function* () {
    return yield* GitHubClient;
  }).pipe(Effect.provide(GitHubClientLive({ token })));

  const notifications = yield* makeGitHubBinding({
    accountId: account.id,
    initialLookbackDays: account.initialLookbackDays,
    ...(account.repositories === undefined ? {} : { repositoryFilter: account.repositories }),
  }).pipe(Effect.provideService(GitHubClient, client));
  const watchProvider = yield* makeGitHubPullRequestWatchProvider(account.id).pipe(Effect.provideService(GitHubClient, client));
  const watch = watchBinding(watchProvider, pullRequestConditions);

  return [
    { name: notifications.source, interval: NOTIFICATION_SYNC_INTERVAL, run: syncSource(notifications), backoffUntil: githubBackoffUntil },
    { name: watch.source, interval: WATCH_SYNC_INTERVAL, run: syncSource(watch), backoffUntil: githubBackoffUntil },
  ] satisfies ReadonlyArray<SyncJob<GitHubJobError, unknown>>;
});
