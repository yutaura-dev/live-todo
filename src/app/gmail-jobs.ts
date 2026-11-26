import { Effect, Layer, Option } from "effect";
import type { DateTime } from "effect";
import { MailClassifier } from "../core/judge/mail-classifier.js";
import type { SyncJob } from "../core/sync/scheduler.js";
import { syncSource } from "../core/sync/sync-source.js";
import { makeGmailSendersBinding, makeGmailThreadsBinding, refreshSenderBriefs } from "../sources/gmail/gmail-bindings.js";
import { GmailClient, type GmailClientError } from "../sources/gmail/gmail-client.js";
import type { SqlClient } from "effect/sql";
import type { Database } from "../core/db/database.js";
import type { JudgeRequestError } from "../core/judge/todo-judge.js";
import type { SourceItemRepository } from "../core/source/source-item-repository.js";
import type { DuplicateExternalIdError } from "../core/sync/snapshot-differ.js";
import type { TaskRepository } from "../core/task/task-repository.js";
import { GmailClientLive, Gws } from "../sources/gmail/gmail-client-live.js";
import { ingestGmail } from "../sources/gmail/gmail-ingest.js";
import { applyGmailRules } from "../sources/gmail/gmail-rule-runner.js";
import type { Rule } from "../core/rules/rule.js";
import type { ResolvedGmailAccount } from "./config/app-config.js";
import { makeMailClassifier } from "./llm.js";
import { applyGmailSenderPlans } from "./gmail-plans.js";

export const GMAIL_SYNC_INTERVAL = "2 minutes";

export type GmailJobError = GmailClientError | JudgeRequestError | DuplicateExternalIdError;
export type GmailJobRequirements = Database | SourceItemRepository | TaskRepository | SqlClient.SqlClient;

/** 取り込みと仕分けをしてから、送り主ごと・スレッドごとの Source Item を作り直す（同じ表から作るので続けて動かす） */
export const runGmailSync = Effect.fnUntraced(function* (accountId: string, rules: ReadonlyArray<Rule> = []) {
  yield* ingestGmail({ accountId });
  // 用件を判定したあと、送り主にまとめる前に当てる（既読・アーカイブを、まとめた Task の未処理の数に反映するため）
  yield* applyGmailRules(accountId, rules);
  yield* syncSource(yield* makeGmailSendersBinding({ accountId }));
  yield* refreshSenderBriefs(accountId);
  yield* applyGmailSenderPlans(accountId);
  yield* syncSource(yield* makeGmailThreadsBinding({ accountId }));
});

export const makeGmailJobs = Effect.fnUntraced(function* (account: ResolvedGmailAccount, rules: ReadonlyArray<Rule> = []) {
  // 仕分けはこのアカウントの LLM Profile の Decisions でだけ行う（charter の前提と制約）
  const classifier = yield* makeMailClassifier(account.resolvedLlmProfile);
  const client = yield* Effect.gen(function* () {
    return yield* GmailClient;
  }).pipe(Effect.provide(GmailClientLive.pipe(Layer.provide(Gws.layer))));
  const job: SyncJob<GmailJobError, GmailJobRequirements> = {
    name: `gmail:${account.id}`,
    interval: GMAIL_SYNC_INTERVAL,
    run: runGmailSync(account.id, rules).pipe(Effect.provideService(GmailClient, client), Effect.provideService(MailClassifier, classifier)),
    backoffUntil: () => Option.none<DateTime.Utc>(),
  };
  return [job];
});
