import { DateTime, Effect, Layer, Option } from "effect";
import { HttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";
import { SecretVault } from "../core/config/encrypted-secret-store.js";
import { SecretStore } from "../core/config/secret-store.js";
import { DecisionsProvider, type JudgeRequestError, StructuredClassifier, type TodoJudgeThresholds } from "../core/judge/todo-judge.js";
import type { SourceItemRepository } from "../core/source/source-item-repository.js";
import type { SyncJob } from "../core/sync/scheduler.js";
import { syncSource } from "../core/sync/sync-source.js";
import type { TaskRepository } from "../core/task/task-repository.js";
import { makeCalendarBindings } from "../sources/calendar/calendar-bindings.js";
import type { CalendarEvent } from "../sources/calendar/calendar-events.js";
import { GraphClient, type GraphError, GraphClientLive, type MicrosoftRateLimitedError } from "../sources/microsoft/graph-client.js";
import type { MicrosoftApp } from "../sources/microsoft/microsoft-auth.js";
import { MicrosoftTokenLive } from "../sources/microsoft/microsoft-token.js";
import { outlookEventFrom } from "../sources/microsoft/outlook-calendar.js";
import type { MicrosoftAccount, ResolvedMicrosoftAccount } from "./config/app-config.js";
import { judgeThresholdsFor, makeDecisionsProvider, makeStructuredClassifier } from "./llm.js";

export const OUTLOOK_CALENDAR_INTERVAL = "5 minutes";
const LOOKBACK_DAYS = 1;
const LOOKAHEAD_DAYS = 31;
const EVENT_FIELDS = "id,subject,bodyPreview,isAllDay,isCancelled,isOrganizer,showAs,responseRequested,webLink,start,end,responseStatus,attendees";

export type MicrosoftJobRequirements = SourceItemRepository | TaskRepository | SqlClient.SqlClient;
export type MicrosoftJobError = GraphError | JudgeRequestError;

export const microsoftRefreshTokenKey = (accountId: string) => `microsoft.${accountId}.refresh_token`;

/** サインインで求める権限。使う機能を増やしたら、サインインし直してもらう */
export const microsoftScopes = (features: Pick<MicrosoftAccount, "calendar">): string[] => ["offline_access", "User.Read", ...(features.calendar ? ["Calendars.Read"] : [])];

export const microsoftAppOf = (account: MicrosoftAccount): MicrosoftApp => ({ tenantId: account.tenantId, clientId: account.clientId, scopes: microsoftScopes(account) });

export const microsoftBackoffUntil = (error: MicrosoftJobError): Option.Option<DateTime.Utc> =>
  error._tag === "MicrosoftRateLimitedError" ? DateTime.make((error as MicrosoftRateLimitedError).resetAt) : Option.none();

/** 保存したリフレッシュトークンで Graph を読むクライアント。入れ替わったリフレッシュトークンは保存し直す */
export const graphClientFor = Effect.fnUntraced(function* (account: MicrosoftAccount) {
  const secrets = yield* SecretStore;
  const vault = yield* SecretVault;
  const http = yield* HttpClient.HttpClient;
  const key = microsoftRefreshTokenKey(account.id);
  const token = MicrosoftTokenLive({
    ...microsoftAppOf(account),
    loadRefreshToken: secrets.get(key),
    saveRefreshToken: (value) =>
      vault.set(key, value).pipe(Effect.catch((error) => Effect.logWarning("Microsoft のリフレッシュトークンを保存できなかった").pipe(Effect.annotateLogs({ reason: error.message })))),
  });
  return yield* Effect.gen(function* () {
    return yield* GraphClient;
  }).pipe(Effect.provide(GraphClientLive.pipe(Layer.provide(token))), Effect.provideService(HttpClient.HttpClient, http));
});

/** Outlook の予定を取り、Google Calendar と同じ 3 つの Source（頭は outlook）に反映する（ADR-0017） */
export const runOutlookCalendarSync = Effect.fnUntraced(function* (options: { accountId: string; timeZone: string; thresholds?: TodoJudgeThresholds }) {
  const graph = yield* GraphClient;
  const me = (yield* graph.get("/me", { query: { $select: "mail,userPrincipalName" } })) as { mail?: string | null; userPrincipalName?: string };
  const address = me.mail ?? me.userPrincipalName ?? "";
  const now = yield* DateTime.now;
  const raws = yield* graph.getAll("/me/calendarView", {
    query: {
      startDateTime: DateTime.formatIso(DateTime.subtract(now, { days: LOOKBACK_DAYS })),
      endDateTime: DateTime.formatIso(DateTime.add(now, { days: LOOKAHEAD_DAYS })),
      $select: EVENT_FIELDS,
      $top: "100",
    },
    // 時刻を UTC でもらう（既定はイベントごとのタイムゾーンで、Windows のタイムゾーン名が混じる）
    headers: { prefer: 'outlook.timezone="UTC"' },
  });
  const events: CalendarEvent[] = [];
  let malformed = 0;
  for (const raw of raws) {
    const event = outlookEventFrom(raw, { address, timeZone: options.timeZone });
    if (Option.isSome(event)) events.push(event.value);
    else malformed++;
  }
  if (malformed > 0) yield* Effect.logWarning("形の分からない Outlook の予定を取り込まなかった").pipe(Effect.annotateLogs({ count: malformed }));

  const bindings = yield* makeCalendarBindings({
    accountId: options.accountId,
    events,
    sourcePrefix: "outlook",
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  });
  yield* syncSource(bindings.invites);
  yield* syncSource(bindings.prep);
  yield* syncSource(bindings.todos);
});

export const makeMicrosoftJobs = Effect.fnUntraced(function* (account: ResolvedMicrosoftAccount, options: { timeZone: string }) {
  if (Option.isNone(yield* (yield* SecretStore).get(microsoftRefreshTokenKey(account.id)))) return [];
  const graph = yield* graphClientFor(account);
  // 判定はこのアカウントの LLM Profile でだけ行う（charter の前提と制約）
  const classifier = yield* makeStructuredClassifier(account.resolvedLlmProfile);
  const decisions = yield* makeDecisionsProvider(account.resolvedLlmProfile);
  const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const provided = effect.pipe(Effect.provideService(GraphClient, graph), Effect.provideService(StructuredClassifier, classifier));
    return Option.isSome(decisions) ? provided.pipe(Effect.provideService(DecisionsProvider, decisions.value)) : provided;
  };

  const jobs: SyncJob<MicrosoftJobError, MicrosoftJobRequirements>[] = [];
  if (account.calendar) {
    jobs.push({
      name: `outlook:${account.id}:calendar`,
      interval: OUTLOOK_CALENDAR_INTERVAL,
      run: withServices(runOutlookCalendarSync({ accountId: account.id, timeZone: options.timeZone, thresholds: judgeThresholdsFor(account.resolvedLlmProfile) })),
      backoffUntil: microsoftBackoffUntil,
    });
  }
  return jobs;
});

