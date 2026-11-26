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
import type { SlackAccount } from "./config/app-config.js";

// 1 回の同期で saved.list を 2 回以上（未完了と完了済み）と、新しい項目の本文を呼ぶ。Tier 2（毎分 20 回程度）に収める
export const SLACK_SYNC_INTERVAL = "2 minutes";

export type SlackJobRequirements = SourceItemRepository | TaskRepository | SqlClient.SqlClient;

export const slackBackoffUntil = (error: SlackClientError): Option.Option<DateTime.Utc> =>
  error._tag === "SlackRateLimitedError" ? DateTime.make(error.resetAt) : Option.none();

export const makeSlackJobs = Effect.fnUntraced(function* (account: SlackAccount) {
  const secrets = yield* SecretStore;
  const token = yield* secrets.require(`slack.${account.id}.token`);
  const cookie = yield* secrets.require(`slack.${account.id}.cookie`);
  const client = yield* Effect.gen(function* () {
    return yield* SlackClient;
  }).pipe(Effect.provide(SlackClientLive({ workspace: account.workspace, token, cookie, userAgent: account.userAgent })));

  const saved = yield* makeSlackSavedBinding({ accountId: account.id, workspace: account.workspace }).pipe(Effect.provideService(SlackClient, client));
  const jobs: ReadonlyArray<SyncJob<SlackClientError, SlackJobRequirements>> = [
    { name: saved.source, interval: SLACK_SYNC_INTERVAL, run: syncSource(saved), backoffUntil: slackBackoffUntil },
  ];
  return jobs;
});
