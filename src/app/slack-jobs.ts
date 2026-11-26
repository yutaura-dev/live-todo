import { DateTime, Effect, Option } from "effect";
import type { SqlClient } from "effect/sql";
import { SecretStore } from "../core/config/secret-store.js";
import type { SyncJob } from "../core/sync/scheduler.js";
import { syncSource } from "../core/sync/sync-source.js";
import type { SourceItemRepository } from "../core/source/source-item-repository.js";
import type { TaskRepository } from "../core/task/task-repository.js";
import { SlackClient, type SlackClientError } from "../sources/slack/slack-client.js";
import { SlackClientLive } from "../sources/slack/slack-client-live.js";
import { makeSlackSavedBinding } from "../sources/slack/slack-saved.js";
import type { ResolvedSlackAccount } from "./config/app-config.js";
import { DecisionsProvider, type JudgeRequestError, StructuredClassifier } from "../core/judge/todo-judge.js";
import { makeSlackInboxBinding } from "../sources/slack/slack-inbox.js";
import { judgeThresholdsFor, makeDecisionsProvider, makeStructuredClassifier } from "./llm.js";

// 1 回の同期で saved.list を 2 回以上（未完了と完了済み）と、新しい項目の本文を呼ぶ。Tier 2（毎分 20 回程度）に収める
export const SLACK_SYNC_INTERVAL = "2 minutes";

// 1 回に検索を 5 回以上（メンション・グループ・DM・自分の発言・スレッド）と To-do の一覧を呼ぶので、To-do より間を空ける
export const SLACK_INBOX_INTERVAL = "5 minutes";

export type SlackJobRequirements = SourceItemRepository | TaskRepository | SqlClient.SqlClient;
export type SlackJobError = SlackClientError | JudgeRequestError;

export const slackBackoffUntil = (error: SlackJobError): Option.Option<DateTime.Utc> =>
  error._tag === "SlackRateLimitedError" ? DateTime.make(error.resetAt) : Option.none();

export const makeSlackJobs = Effect.fnUntraced(function* (account: ResolvedSlackAccount) {
  const secrets = yield* SecretStore;
  const token = yield* secrets.require(`slack.${account.id}.token`);
  const cookie = yield* secrets.require(`slack.${account.id}.cookie`);
  const client = yield* Effect.gen(function* () {
    return yield* SlackClient;
  }).pipe(Effect.provide(SlackClientLive({ workspace: account.workspace, token, cookie, userAgent: account.userAgent })));

  const saved = yield* makeSlackSavedBinding({ accountId: account.id, workspace: account.workspace }).pipe(Effect.provideService(SlackClient, client));
  const inbox = yield* makeSlackInboxBinding({
    accountId: account.id,
    workspace: account.workspace,
    thresholds: judgeThresholdsFor(account.resolvedLlmProfile),
  }).pipe(Effect.provideService(SlackClient, client));

  // 判定はこのアカウントの LLM Profile でだけ行う（charter の前提と制約。GitHub と同じ）
  const classifier = yield* makeStructuredClassifier(account.resolvedLlmProfile);
  const decisions = yield* makeDecisionsProvider(account.resolvedLlmProfile);
  const withJudges = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const withClassifier = effect.pipe(Effect.provideService(StructuredClassifier, classifier));
    return Option.isSome(decisions) ? withClassifier.pipe(Effect.provideService(DecisionsProvider, decisions.value)) : withClassifier;
  };

  const jobs: ReadonlyArray<SyncJob<SlackJobError, SlackJobRequirements>> = [
    { name: saved.source, interval: SLACK_SYNC_INTERVAL, run: syncSource(saved), backoffUntil: slackBackoffUntil },
    { name: inbox.source, interval: SLACK_INBOX_INTERVAL, run: withJudges(syncSource(inbox)), backoffUntil: slackBackoffUntil },
  ];
  return jobs;
});
