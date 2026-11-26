import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
import { Database } from "../core/db/database.js";
import { recurringTasks, tasks } from "../core/db/schema.js";
import { decodePlan, type NextActionPlan, templateOf } from "../core/task/next-actions.js";
import { type CalendarDate, periodLabel, periodToCreate, RecurrenceSchedule, upcomingPeriod } from "../core/task/recurrence.js";
import { TaskRepository } from "../core/task/task-repository.js";

export class RecurringTaskError extends Schema.TaggedError<RecurringTaskError>()("RecurringTaskError", { message: Schema.String }) {}

export type RecurringTaskInput = {
  title: string;
  note: string;
  schedule: RecurrenceSchedule;
  nextActions?: NextActionPlan | undefined;
  /** 登録した時点で時期を過ぎた今月の分も、すぐに作るか */
  includeCurrent?: boolean | undefined;
};

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const decodeSchedule = Schema.decodeUnknownEffect(RecurrenceSchedule);
const FINISHED = ["done", "dismissed", "archived"] as const;

/** 定期の Task の決まりを登録する。登録した時点で時期を過ぎた今月の分は、includeCurrent のときだけ作る */
export const createRecurringTask = Effect.fnUntraced(function* (input: RecurringTaskInput, today: CalendarDate) {
  const db = yield* Database;
  const title = input.title.trim();
  if (title === "") return yield* new RecurringTaskError({ message: "タイトルが空" });
  const schedule = yield* decodeSchedule(input.schedule).pipe(Effect.mapError(() => new RecurringTaskError({ message: "いつ作るかの指定が正しくない" })));
  const current = Option.getOrNull(periodToCreate(schedule, today));
  const now = yield* nowIso;
  const [row] = yield* db
    .insert(recurringTasks)
    .values({
      title,
      note: input.note.trim(),
      nextActions: input.nextActions === undefined ? null : templateOf(input.nextActions),
      schedule,
      lastPeriod: input.includeCurrent === true ? null : current,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: recurringTasks.id })
    .pipe(Effect.orDie);
  return row!.id;
});

/** Task をもとに定期の Task を作る（ドロワーのボタンと、将来の AI の提案の入口）。タイトルの「（何月分）」は除く */
export const createRecurringFromTask = Effect.fnUntraced(function* (
  taskId: number,
  input: { schedule: RecurrenceSchedule; note: string; includeCurrent?: boolean },
  today: CalendarDate,
) {
  const task = yield* (yield* TaskRepository).findTask(taskId);
  if (Option.isNone(task)) return yield* new RecurringTaskError({ message: "Task が見つからない" });
  return yield* createRecurringTask(
    {
      title: task.value.title.replace(/（(\d{4}年)?\d{1,2}月分）$/, ""),
      note: input.note,
      schedule: input.schedule,
      nextActions: Option.getOrUndefined(decodePlan(task.value.nextActions)),
      includeCurrent: input.includeCurrent,
    },
    today,
  );
});

export const listRecurringTasks = Effect.gen(function* () {
  return yield* (yield* Database).select().from(recurringTasks).orderBy(asc(recurringTasks.id)).pipe(Effect.orDie);
});

export const updateRecurringActive = Effect.fnUntraced(function* (id: number, active: boolean) {
  yield* (yield* Database).update(recurringTasks).set({ active, updatedAt: yield* nowIso }).where(eq(recurringTasks.id, id)).pipe(Effect.orDie);
});

export const updateRecurringTask = Effect.fnUntraced(function* (id: number, patch: { title?: string; note?: string; schedule?: RecurrenceSchedule }) {
  const schedule = patch.schedule === undefined ? undefined : yield* decodeSchedule(patch.schedule).pipe(Effect.mapError(() => new RecurringTaskError({ message: "いつ作るかの指定が正しくない" })));
  yield* (yield* Database)
    .update(recurringTasks)
    .set({
      ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
      ...(patch.note === undefined ? {} : { note: patch.note.trim() }),
      ...(schedule === undefined ? {} : { schedule }),
      updatedAt: yield* nowIso,
    })
    .where(eq(recurringTasks.id, id))
    .pipe(Effect.orDie);
});

type RecurringRule = typeof recurringTasks.$inferSelect;

const scheduleOf = (rule: RecurringRule) => Option.getOrUndefined(Schema.decodeUnknownOption(RecurrenceSchedule)(rule.schedule));

/** 時期が来た決まりから Task を作る。作った数を返す */
export const runRecurringTasks = Effect.fnUntraced(function* (today: CalendarDate) {
  const db = yield* Database;
  const rules = yield* db.select().from(recurringTasks).where(eq(recurringTasks.active, true)).pipe(Effect.orDie);
  let created = 0;
  for (const rule of rules) {
    const schedule = scheduleOf(rule);
    if (schedule === undefined) continue;
    const period = Option.getOrUndefined(periodToCreate(schedule, today));
    if (period === undefined || (rule.lastPeriod !== null && period <= rule.lastPeriod)) continue;
    yield* createForPeriod(rule, period, today);
    created++;
  }
  return created;
});

/** 作る日が近い（GHOST_WINDOW_DAYS 日以内）、まだ作っていない定期の Task の予告 */
export const upcomingRecurringTasks = Effect.fnUntraced(function* (today: CalendarDate) {
  const rules = yield* (yield* Database).select().from(recurringTasks).where(eq(recurringTasks.active, true)).orderBy(asc(recurringTasks.id)).pipe(Effect.orDie);
  return rules.flatMap((rule) => {
    const schedule = scheduleOf(rule);
    const upcoming = schedule === undefined ? Option.none() : upcomingPeriod(schedule, today, rule.lastPeriod);
    return Option.match(upcoming, {
      onNone: () => [],
      onSome: ({ period, date, daysLeft }) => [{ ruleId: rule.id, title: `${rule.title}（${periodLabel(period, today.year)}）`, period, date, daysLeft }],
    });
  });
});

/** 予告している月の分を、作る日を待たずに今すぐ作る */
export const createRecurringNow = Effect.fnUntraced(function* (ruleId: number, today: CalendarDate) {
  const [rule] = yield* (yield* Database).select().from(recurringTasks).where(eq(recurringTasks.id, ruleId)).pipe(Effect.orDie);
  const schedule = rule === undefined ? undefined : scheduleOf(rule);
  if (rule === undefined || schedule === undefined) return yield* new RecurringTaskError({ message: "定期の Task が見つからない" });
  const upcoming = upcomingPeriod(schedule, today, rule.lastPeriod);
  if (Option.isNone(upcoming)) return yield* new RecurringTaskError({ message: "今すぐ作れる月の分がない（もう作ったか、まだ先）" });
  yield* createForPeriod(rule, upcoming.value.period, today);
});

const createForPeriod = Effect.fnUntraced(function* (rule: RecurringRule, period: string, today: CalendarDate) {
  const db = yield* Database;
  const taskRepository = yield* TaskRepository;
  {

    const unfinished = yield* db
      .select({ period: tasks.recurrencePeriod })
      .from(tasks)
      .where(and(eq(tasks.recurringTaskId, rule.id), isNotNull(tasks.recurrencePeriod)))
      .pipe(Effect.orDie);
    const finished = yield* db
      .select({ period: tasks.recurrencePeriod })
      .from(tasks)
      .where(and(eq(tasks.recurringTaskId, rule.id), inArray(tasks.status, [...FINISHED])))
      .pipe(Effect.orDie);
    const finishedPeriods = new Set(finished.map((row) => row.period));
    const left = unfinished.map((row) => row.period).filter((value): value is string => value !== null && !finishedPeriods.has(value));
    const warning =
      left.length === 0 ? [] : [`${left.toSorted().map((value) => periodLabel(value, today.year)).join("・")}がまだ終わっていない`];

    const task = yield* taskRepository.createTask({ title: `${rule.title}（${periodLabel(period, today.year)}）`, status: "todo" });
    const brief = [...warning, ...(rule.note === "" ? [] : [rule.note])].join("\n");
    const plan = Option.getOrUndefined(decodePlan(rule.nextActions));
    yield* taskRepository.updateTask(task.id, {
      recurringTaskId: rule.id,
      recurrencePeriod: period,
      ...(brief === "" ? {} : { brief }),
      ...(plan === undefined ? {} : { nextActions: plan }),
    });
    yield* taskRepository.recordChange(task.id, { kind: "created", after: { recurringTaskId: rule.id, period }, unread: true, actor: "agent" });
    yield* db.update(recurringTasks).set({ lastPeriod: period, updatedAt: yield* nowIso }).where(eq(recurringTasks.id, rule.id)).pipe(Effect.orDie);
  }
});

/** PC のタイムゾーンでの今日の日付 */
export const localToday = Effect.gen(function* () {
  const parts = DateTime.toParts(yield* DateTime.nowInCurrentZone);
  return { year: parts.year, month: parts.month, day: parts.day } satisfies CalendarDate;
}).pipe(DateTime.withCurrentZoneLocal);
