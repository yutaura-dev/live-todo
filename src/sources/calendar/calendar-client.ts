import { Context, type Effect, Schema } from "effect";
import type { CalendarInfo } from "./calendar-events.js";

export class CalendarRequestError extends Schema.TaggedError<CalendarRequestError>()("CalendarRequestError", {
  message: Schema.String,
}) {}

/** Google Calendar の API（認証は gws に任せる） */
export class CalendarClient extends Context.Service<CalendarClient, {
  /** 書き込めるカレンダー（owner・writer）。読むだけのカレンダー（祝日・他人の予定）は、自分の todo にならないので除く */
  readonly writableCalendars: Effect.Effect<ReadonlyArray<CalendarInfo>, CalendarRequestError>;
  /** 範囲の中の予定（繰り返しは展開し、取り消された予定も含める）。中身はまだ検証していない */
  events(calendarId: string, range: { timeMin: string; timeMax: string }): Effect.Effect<ReadonlyArray<unknown>, CalendarRequestError>;
}>()("live-todo/sources/calendar/CalendarClient") {}
