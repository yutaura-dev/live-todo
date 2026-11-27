import { DateTime, Effect, Option } from "effect";
import type { SqlClient } from "effect/sql";
import { SecretStore } from "../core/config/secret-store.js";
import { DecisionsProvider, type JudgeRequestError, StructuredClassifier } from "../core/judge/todo-judge.js";
import type { SourceItemRepository } from "../core/source/source-item-repository.js";
import type { SyncJob } from "../core/sync/scheduler.js";
import { syncSource } from "../core/sync/sync-source.js";
import type { TaskRepository } from "../core/task/task-repository.js";
import { NotionClient, type NotionClientError } from "../sources/notion/notion-client.js";
import { NotionClientLive } from "../sources/notion/notion-client-live.js";
import { makeNotionInboxBinding } from "../sources/notion/notion-inbox.js";
import type { ResolvedNotionAccount } from "./config/app-config.js";
import { judgeThresholdsFor, makeDecisionsProvider, makeStructuredClassifier } from "./llm.js";

// 1 回の同期で、自分の確認（getSpaces）とワークスペースごとの受信トレイを呼ぶ。非公開 API なので控えめにする
export const NOTION_INBOX_INTERVAL = "3 minutes";

export type NotionJobRequirements = SourceItemRepository | TaskRepository | SqlClient.SqlClient;
export type NotionJobError = NotionClientError | JudgeRequestError;

export const notionBackoffUntil = (error: NotionJobError): Option.Option<DateTime.Utc> =>
  error._tag === "NotionRateLimitedError" ? DateTime.make(error.resetAt) : Option.none();

export const notionTokenKey = (accountId: string) => `notion.${accountId}.token`;

export const makeNotionJobs = Effect.fnUntraced(function* (account: ResolvedNotionAccount) {
  const secrets = yield* SecretStore;
  const token = yield* secrets.require(notionTokenKey(account.id));
  const client = yield* Effect.gen(function* () {
    return yield* NotionClient;
  }).pipe(Effect.provide(NotionClientLive({ token, userId: account.userId, userAgent: account.userAgent, origin: account.origin })));

  const inbox = yield* makeNotionInboxBinding({ accountId: account.id, thresholds: judgeThresholdsFor(account.resolvedLlmProfile) }).pipe(
    Effect.provideService(NotionClient, client),
  );

  // 判定はこのアカウントの LLM Profile でだけ行う（charter の前提と制約。Slack と同じ）
  const classifier = yield* makeStructuredClassifier(account.resolvedLlmProfile);
  const decisions = yield* makeDecisionsProvider(account.resolvedLlmProfile);
  const withJudges = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const withClassifier = effect.pipe(Effect.provideService(StructuredClassifier, classifier));
    return Option.isSome(decisions) ? withClassifier.pipe(Effect.provideService(DecisionsProvider, decisions.value)) : withClassifier;
  };

  const jobs: ReadonlyArray<SyncJob<NotionJobError, NotionJobRequirements>> = [
    { name: inbox.source, interval: NOTION_INBOX_INTERVAL, run: withJudges(syncSource(inbox)), backoffUntil: notionBackoffUntil },
  ];
  return jobs;
});
