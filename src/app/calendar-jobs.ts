import { DateTime, Effect, Layer, Option } from "effect";
import type { SqlClient } from "effect/sql";
import { DecisionsProvider, type JudgeRequestError, StructuredClassifier, type TodoJudgeThresholds } from "../core/judge/todo-judge.js";
import type { SourceItemRepository } from "../core/source/source-item-repository.js";
import type { SyncJob } from "../core/sync/scheduler.js";
import { syncSource } from "../core/sync/sync-source.js";
import type { TaskRepository } from "../core/task/task-repository.js";
import { makeCalendarBindings } from "../sources/calendar/calendar-bindings.js";
import { CalendarClient, type CalendarRequestError } from "../sources/calendar/calendar-client.js";
import { CalendarClientLive } from "../sources/calendar/calendar-client-live.js";
import { type CalendarEvent, eventFrom } from "../sources/calendar/calendar-events.js";
import { Gws } from "../sources/gmail/gmail-client-live.js";
import type { ResolvedCalendarAccount } from "./config/app-config.js";
import { judgeThresholdsFor, makeDecisionsProvider, makeStructuredClassifier } from "./llm.js";

// 1 回の同期で、カレンダーの一覧と書き込めるカレンダーの数だけ gws を動かす。予定は分単位でしか変わらないので 5 分で足りる
export const CALENDAR_SYNC_INTERVAL = "5 minutes";
// 前日から取る理由: 終わったばかりの予定を一度見て、出欠や準備の Task を済んだことにするため
const LOOKBACK_DAYS = 1;
// 出欠は先の予定でも要るので、準備（3 日）より広く取る
const LOOKAHEAD_DAYS = 31;

export type CalendarJobRequirements = SourceItemRepository | TaskRepository | SqlClient.SqlClient;
export type CalendarJobError = CalendarRequestError | JudgeRequestError;

/** 予定を 1 度だけ取り、出欠・準備・自分の todo の 3 つの Source に続けて反映する */
export const runCalendarSync = Effect.fnUntraced(function* (options: { accountId: string; thresholds?: TodoJudgeThresholds }) {
  const client = yield* CalendarClient;
  const now = yield* DateTime.now;
  const range = {
    timeMin: DateTime.formatIso(DateTime.subtract(now, { days: LOOKBACK_DAYS })),
    timeMax: DateTime.formatIso(DateTime.add(now, { days: LOOKAHEAD_DAYS })),
  };
  const events: CalendarEvent[] = [];
  let malformed = 0;
  for (const calendar of yield* client.writableCalendars) {
    for (const raw of yield* client.events(calendar.id, range)) {
      const event = eventFrom(raw, calendar);
      if (Option.isSome(event)) events.push(event.value);
      else malformed++;
    }
  }
  if (malformed > 0) yield* Effect.logWarning("形の分からない Calendar の予定を取り込まなかった").pipe(Effect.annotateLogs({ count: malformed }));

  const bindings = yield* makeCalendarBindings({ accountId: options.accountId, events, ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }) });
  yield* syncSource(bindings.invites);
  yield* syncSource(bindings.prep);
  yield* syncSource(bindings.todos);
});

export const makeCalendarJobs = Effect.fnUntraced(function* (account: ResolvedCalendarAccount) {
  const client = yield* Effect.gen(function* () {
    return yield* CalendarClient;
  }).pipe(Effect.provide(CalendarClientLive.pipe(Layer.provide(Gws.layer))));
  // 判定はこのアカウントの LLM Profile でだけ行う（charter の前提と制約）
  const classifier = yield* makeStructuredClassifier(account.resolvedLlmProfile);
  const decisions = yield* makeDecisionsProvider(account.resolvedLlmProfile);
  const run = runCalendarSync({ accountId: account.id, thresholds: judgeThresholdsFor(account.resolvedLlmProfile) }).pipe(
    Effect.provideService(CalendarClient, client),
    Effect.provideService(StructuredClassifier, classifier),
  );

  const jobs: ReadonlyArray<SyncJob<CalendarJobError, CalendarJobRequirements>> = [
    {
      name: `calendar:${account.id}`,
      interval: CALENDAR_SYNC_INTERVAL,
      run: Option.isSome(decisions) ? run.pipe(Effect.provideService(DecisionsProvider, decisions.value)) : run,
      backoffUntil: () => Option.none<DateTime.Utc>(),
    },
  ];
  return jobs;
});
