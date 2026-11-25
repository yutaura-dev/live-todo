import { DateTime, Effect, Option } from "effect";
import type { SqlClient } from "effect/sql";
import type { Database } from "../core/db/database.js";
import type { SourceItemRepository } from "../core/source/source-item-repository.js";
import type { TaskRepository } from "../core/task/task-repository.js";
import { SecretStore } from "../core/config/secret-store.js";
import type { SyncJob } from "../core/sync/scheduler.js";
import { syncSource } from "../core/sync/sync-source.js";
import { watchBinding } from "../core/watch/watch-binding.js";
import { type GitHubAdapterError, GitHubClient } from "../sources/github/github-adapter.js";
import { makeGitHubBinding } from "../sources/github/github-binding.js";
import { GitHubClientLive } from "../sources/github/github-client-live.js";
import { makeGitHubPullRequestWatchProvider, pullRequestConditions } from "../sources/github/github-watch.js";
import { DecisionsProvider, type JudgeRequestError, StructuredClassifier } from "../core/judge/todo-judge.js";
import { judgeThresholdsFor, makeDecisionsProvider, makeStructuredClassifier } from "./llm.js";
import { backfillGitHubPullAuthors } from "./github-author-backfill.js";
import { checkWaitConditions } from "./wait-watch.js";
import { refreshTrackedItems } from "./item-refresh.js";
import type { ResolvedAccount } from "./config/app-config.js";

export const NOTIFICATION_SYNC_INTERVAL = "1 minute";
// 見張りの間隔を通知より長くする理由: 見張りは自分の open な PR ごとに 3 回（詳細・check・レビュー）API を呼ぶため。
export const WATCH_SYNC_INTERVAL = "5 minutes";
// 作成者の埋め直しは、作成者の列を足す前の項目のためのもの。新しい項目は同期で作成者が入るので、頻繁に回さない
export const AUTHOR_BACKFILL_INTERVAL = "1 day";
// 待つ手順の条件は、待っている Task ごとに 1 回 API を呼ぶだけなので、見張りと同じ間隔にする
export const WAIT_CHECK_INTERVAL = "5 minutes";
// 通知の来ない状態の変化（自分で merge した PR など）を拾う。終わっていない Task の項目ごとに 1 回 API を呼ぶ
export const ITEM_REFRESH_INTERVAL = "5 minutes";

export type GitHubJobError = GitHubAdapterError | JudgeRequestError;
export type GitHubJobRequirements = SourceItemRepository | TaskRepository | SqlClient.SqlClient | Database;

export const githubBackoffUntil = (error: GitHubJobError): Option.Option<DateTime.Utc> =>
  error._tag === "GitHubRateLimitedError" ? DateTime.make(error.resetAt) : Option.none();

export const makeGitHubJobs = Effect.fnUntraced(function* (account: ResolvedAccount) {
  const token = yield* (yield* SecretStore).require(`github.${account.id}.token`);

  // クライアントをアカウントごとに 1 つだけ作り、2 つのジョブで共有する理由: GitHubClientLive はトークンごとに
  // 1 本のキューとレート制限のブレーカーを持つので、ジョブごとに作るとキューが分かれて並行に送ってしまう。
  const client = yield* Effect.gen(function* () {
    return yield* GitHubClient;
  }).pipe(Effect.provide(GitHubClientLive({ token })));

  const repositoryFilter = account.repositories === undefined ? {} : { repositoryFilter: account.repositories };
  const notifications = yield* makeGitHubBinding({
    accountId: account.id,
    initialLookbackDays: account.initialLookbackDays,
    thresholds: judgeThresholdsFor(account.resolvedLlmProfile),
    ...repositoryFilter,
  }).pipe(Effect.provideService(GitHubClient, client));
  const watchProvider = yield* makeGitHubPullRequestWatchProvider(account.id, repositoryFilter).pipe(
    Effect.provideService(GitHubClient, client),
  );
  // 見張りの最初の間隔をジョブの間隔にそろえる理由: 最初の間隔より短く回しても、確認する時刻が来ていない対象は飛ばされるだけなので。
  const watch = watchBinding(watchProvider, pullRequestConditions, { initial: WATCH_SYNC_INTERVAL, max: "1 day" });

  // classifier をアカウントごとに作ってそのジョブにだけ渡す理由: 会社のデータは会社が許可した LLM にだけ
  // 送るという charter の制約を、組み立ての段階で守らせるため（外から 1 つ渡すと全アカウントで共有される）。
  const classifier = yield* makeStructuredClassifier(account.resolvedLlmProfile);
  const decisions = yield* makeDecisionsProvider(account.resolvedLlmProfile);
  const withJudges = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const withClassifier = effect.pipe(Effect.provideService(StructuredClassifier, classifier));
    return Option.isSome(decisions) ? withClassifier.pipe(Effect.provideService(DecisionsProvider, decisions.value)) : withClassifier;
  };

  const jobs: ReadonlyArray<SyncJob<GitHubJobError, GitHubJobRequirements>> = [
    { name: notifications.source, interval: NOTIFICATION_SYNC_INTERVAL, run: withJudges(syncSource(notifications)), backoffUntil: githubBackoffUntil },
    { name: watch.source, interval: WATCH_SYNC_INTERVAL, run: syncSource(watch), backoffUntil: githubBackoffUntil },
    { name: `github:${account.id}:refresh`, interval: ITEM_REFRESH_INTERVAL, run: refreshTrackedItems(account.id, client), backoffUntil: githubBackoffUntil },
    { name: `github:${account.id}:waits`, interval: WAIT_CHECK_INTERVAL, run: checkWaitConditions(account.id, client), backoffUntil: githubBackoffUntil },
    {
      name: `github:${account.id}:authors`,
      interval: AUTHOR_BACKFILL_INTERVAL,
      run: backfillGitHubPullAuthors(account.id, client),
      backoffUntil: githubBackoffUntil,
    },
  ];
  return jobs;
});
