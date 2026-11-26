import { DateTime, Duration, Effect, Schema } from "effect";
import { DEFAULT_TODO_THRESHOLDS, makeTodoJudge, type TodoJudgeThresholds, type TodoJudgment } from "../../core/judge/todo-judge.js";
import type { SourceAdapter } from "../../core/sync/source-adapter.js";
import type { SourceChange } from "../../core/sync/source-change.js";
import type { SourceBinding } from "../../core/sync/sync-source.js";
import type { CalendarEvent } from "./calendar-events.js";

export type CalendarItem = { event: CalendarEvent; resolved: boolean; title: string; marked: boolean };

export const CalendarCursorSchema = Schema.Struct({
  items: Schema.Record(
    Schema.String,
    Schema.Struct({ fingerprint: Schema.String, state: Schema.Literals(["open", "resolved"]), endsAt: Schema.Number, title: Schema.String }),
  ),
});
export type CalendarCursor = typeof CalendarCursorSchema.Type;

const PREP_LEAD = Duration.days(3);
const TODO_LEAD = Duration.days(1);
// 終わってからこれだけたった予定は覚えるのをやめる（カーソルが増え続けないように）
const FORGET_AFTER = Duration.days(30);
const MAX_DESCRIPTION = 2000;
const TODO_MARKER = /\bTODO\b|やること|\[ \]|☐/i;
// 出欠を返すこと自体が自分の todo なので、LLM に問わない
const INVITE_JUDGMENT: TodoJudgment = { verdict: "todo", method: "rule" };
const RESPONSE_LABELS = { needsAction: "未回答", accepted: "出席", declined: "欠席", tentative: "仮" } as const;

const PREP_QUESTION = "信頼できる情報にある予定の前に、ユーザー本人が資料の用意・事前の確認・下調べなどの準備をする必要があるか？";
const TODO_QUESTION = "この終日の予定は、ユーザー本人がその日にやる作業か？（休暇・記念日・場所や状態を示すだけの予定ではないか）";

export const calendarSourceName = (accountId: string, kind: "invites" | "prep" | "todos") => `calendar:${accountId}:${kind}`;

const fingerprintOf = (item: CalendarItem) => JSON.stringify([item.resolved, item.title]);

/**
 * 予定の一覧から、条件に当てはまる予定を項目にする。前に開いていた項目は、当てはまらなくなったら済んだことにする。
 * 一覧から消えた項目は、まだ先の予定なら消されたとして removed にし、過ぎて範囲から出ただけなら前の状態のまま覚えておく
 * （SnapshotDiffer を使わない理由: 範囲から出ただけの予定まで removed になり、片付けた Task が archived に変わるため）
 */
const adapterFor = (
  events: ReadonlyArray<CalendarEvent>,
  applies: (event: CalendarEvent, now: number) => boolean,
  titleOf: (event: CalendarEvent) => string,
): SourceAdapter<CalendarItem, CalendarCursor, never> => ({
  fetchChanges: (cursor) =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const forgetBefore = now - Duration.toMillis(FORGET_AFTER);
      const previous = Object.fromEntries(Object.entries(cursor?.items ?? {}).filter(([, entry]) => entry.endsAt >= forgetBefore));
      const next: Record<string, CalendarCursor["items"][string]> = { ...previous };
      const changes: SourceChange<CalendarItem>[] = [];
      const seen = new Set<string>();

      for (const event of events) {
        seen.add(event.key);
        const before = previous[event.key];
        let item: CalendarItem;
        if (applies(event, now)) item = { event, resolved: false, title: titleOf(event), marked: TODO_MARKER.test(event.description) };
        // 済んだときはタイトルを変えない（取り消された予定は名前が消えていることがある）
        else if (before?.state === "open") item = { event, resolved: true, title: before.title, marked: false };
        else continue;
        const fingerprint = fingerprintOf(item);
        if (before?.fingerprint !== fingerprint) changes.push({ kind: "upserted", item });
        next[event.key] = { fingerprint, state: item.resolved ? "resolved" : "open", endsAt: event.endMs, title: item.title };
      }
      for (const [key, entry] of Object.entries(previous)) {
        if (seen.has(key) || entry.state !== "open" || entry.endsAt <= now) continue;
        changes.push({ kind: "removed", externalId: key });
        delete next[key];
      }
      return { changes, nextCursor: { items: next } };
    }),
});

const isInvite = (event: CalendarEvent, now: number) => !event.cancelled && event.selfResponse === "needsAction" && !event.organizerSelf && event.endMs > now;

const isPrep = (event: CalendarEvent, now: number) =>
  !event.cancelled &&
  !event.allDay &&
  event.eventType === "default" &&
  event.endMs > now &&
  event.startMs - now <= Duration.toMillis(PREP_LEAD) &&
  (event.organizerSelf || event.selfResponse === "accepted" || event.selfResponse === "tentative") &&
  event.otherAttendees > 0;

const isTodo = (event: CalendarEvent, now: number) =>
  !event.cancelled &&
  event.creatorSelf &&
  event.otherAttendees === 0 &&
  event.eventType === "default" &&
  (event.allDay || TODO_MARKER.test(event.description)) &&
  event.startMs - now <= Duration.toMillis(TODO_LEAD);

const describeEvent = (event: CalendarEvent) =>
  Effect.succeed({
    context: [
      `カレンダー: ${event.calendarName}`,
      `日時: ${event.startLabel}`,
      `主催: ${event.organizerSelf ? "ユーザー本人" : "ほかの人"}`,
      `参加者: 自分のほかに ${event.otherAttendees} 人`,
      ...(event.selfResponse === undefined ? [] : [`ユーザー本人の出欠: ${RESPONSE_LABELS[event.selfResponse]}`]),
    ].join("\n"),
    input: `${event.summary}\n\n${event.description.slice(0, MAX_DESCRIPTION)}`.trim(),
  });

const bindingOf = <EJ, RJ>(
  source: string,
  adapter: SourceAdapter<CalendarItem, CalendarCursor, never>,
  judge: (item: CalendarItem) => Effect.Effect<TodoJudgment, EJ, RJ>,
) =>
  ({
    source,
    adapter,
    cursorSchema: CalendarCursorSchema,
    externalIdOf: (item: CalendarItem) => item.event.key,
    toItemDraft: (item: CalendarItem) => ({
      title: item.title,
      url: item.event.url,
      state: item.resolved ? ("resolved" as const) : ("open" as const),
      fingerprint: fingerprintOf(item),
    }),
    judge,
    // タイトルは予定の名前と日時から作るので、予定を動かしたら Task にも反映する（自分で書き換えたタイトルは変えない）
    taskTitleFollowsItem: true,
  }) satisfies SourceBinding<CalendarItem, CalendarCursor, never, EJ, RJ>;

/** 同期ごとに取った予定の一覧から、出欠・準備・自分の todo の 3 つの Source を作る（ADR-0016） */
export const makeCalendarBindings = Effect.fnUntraced(function* (options: { accountId: string; events: ReadonlyArray<CalendarEvent>; thresholds?: TodoJudgeThresholds }) {
  const thresholds = options.thresholds ?? DEFAULT_TODO_THRESHOLDS;
  const prepJudge = yield* makeTodoJudge<CalendarItem>({ rules: [], describe: (item) => describeEvent(item.event), question: PREP_QUESTION, thresholds }).pipe(Effect.orDie);
  const todoJudge = yield* makeTodoJudge<CalendarItem>({
    rules: [(item) => item.marked],
    describe: (item) => describeEvent(item.event),
    question: TODO_QUESTION,
    thresholds,
  }).pipe(Effect.orDie);

  return {
    invites: bindingOf(
      calendarSourceName(options.accountId, "invites"),
      adapterFor(options.events, isInvite, (event) => `出欠を返す: ${event.summary}（${event.startLabel}）`),
      () => Effect.succeed(INVITE_JUDGMENT),
    ),
    prep: bindingOf(
      calendarSourceName(options.accountId, "prep"),
      adapterFor(options.events, isPrep, (event) => `準備: ${event.summary}（${event.startLabel}）`),
      prepJudge,
    ),
    todos: bindingOf(calendarSourceName(options.accountId, "todos"), adapterFor(options.events, isTodo, (event) => `${event.summary}（${event.startLabel}）`), todoJudge),
  };
});
