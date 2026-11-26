import { DateTime, Option, Schema } from "effect";

export type CalendarInfo = { id: string; name: string; timeZone: string; primary: boolean };

export type SelfResponse = "needsAction" | "accepted" | "declined" | "tentative";

/** Calendar の予定 1 件。時刻は Unix ミリ秒 */
export type CalendarEvent = {
  /** カレンダーと予定の ID。Source Item の externalId にする */
  key: string;
  calendarId: string;
  calendarName: string;
  eventId: string;
  summary: string;
  description: string;
  cancelled: boolean;
  eventType: string;
  allDay: boolean;
  startMs: number;
  /** 終日の予定は、終わりの日（含まない）の 0 時 */
  endMs: number;
  /** カレンダーのタイムゾーンでの開始の日時（終日なら日付だけ） */
  startLabel: string;
  /** 自分が参加者にいなければ undefined */
  selfResponse: SelfResponse | undefined;
  organizerSelf: boolean;
  creatorSelf: boolean;
  /** 自分と会議室などの設備を除いた参加者の数 */
  otherAttendees: number;
  url: string;
};

const Time = Schema.Struct({ dateTime: Schema.optional(Schema.String), date: Schema.optional(Schema.String) });
const Person = Schema.Struct({ self: Schema.optional(Schema.Boolean) });
const Attendee = Schema.Struct({
  self: Schema.optional(Schema.Boolean),
  resource: Schema.optional(Schema.Boolean),
  responseStatus: Schema.optional(Schema.String),
});
const RawEvent = Schema.Struct({
  id: Schema.String,
  status: Schema.optional(Schema.String),
  eventType: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  htmlLink: Schema.optional(Schema.String),
  start: Schema.optional(Time),
  end: Schema.optional(Time),
  creator: Schema.optional(Person),
  organizer: Schema.optional(Person),
  attendees: Schema.optional(Schema.Array(Attendee)),
});
const decodeRawEvent = Schema.decodeUnknownOption(RawEvent);

const SELF_RESPONSES: ReadonlySet<string> = new Set(["needsAction", "accepted", "declined", "tentative"]);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (value: number) => String(value).padStart(2, "0");

// 終日の予定の日付は、カレンダーのタイムゾーンのその日の 0 時にする（UTC の 0 時にすると日本では 9 時間ずれる）
function epochOf(time: typeof Time.Type | undefined, timeZone: string): Option.Option<number> {
  if (time?.dateTime !== undefined) return Option.map(DateTime.make(time.dateTime), DateTime.toEpochMillis);
  const match = time?.date === undefined ? null : DATE_PATTERN.exec(time.date);
  if (match === null) return Option.none();
  return Option.map(
    DateTime.makeZoned({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, { timeZone, adjustForTimeZone: true }),
    DateTime.toEpochMillis,
  );
}

function labelOf(epochMs: number, allDay: boolean, timeZone: string): string {
  const zoned = DateTime.makeZoned(epochMs, { timeZone });
  if (Option.isNone(zoned)) return "";
  const parts = DateTime.toParts(zoned.value);
  const date = `${parts.month}/${parts.day}`;
  return allDay ? date : `${date} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** gws の予定 1 件を、扱いやすい形にする。取り消された予定は開始・終わりがなくてもよい。形が分からなければ none */
export function eventFrom(raw: unknown, calendar: CalendarInfo): Option.Option<CalendarEvent> {
  const decoded = decodeRawEvent(raw);
  if (Option.isNone(decoded)) return Option.none();
  const event = decoded.value;
  const cancelled = event.status === "cancelled";
  const start = epochOf(event.start, calendar.timeZone);
  const end = epochOf(event.end, calendar.timeZone);
  if (!cancelled && (Option.isNone(start) || Option.isNone(end))) return Option.none();
  const startMs = Option.getOrElse(start, () => 0);
  const allDay = event.start?.dateTime === undefined && event.start?.date !== undefined;
  const self = event.attendees?.find((attendee) => attendee.self === true);
  return Option.some({
    key: `${calendar.id}:${event.id}`,
    calendarId: calendar.id,
    calendarName: calendar.name,
    eventId: event.id,
    summary: event.summary?.trim() || "（無題の予定）",
    description: event.description ?? "",
    cancelled,
    eventType: event.eventType ?? "default",
    allDay,
    startMs,
    endMs: Option.getOrElse(end, () => startMs),
    startLabel: Option.isSome(start) ? labelOf(startMs, allDay, calendar.timeZone) : "",
    selfResponse: self?.responseStatus !== undefined && SELF_RESPONSES.has(self.responseStatus) ? (self.responseStatus as SelfResponse) : undefined,
    organizerSelf: event.organizer?.self === true,
    creatorSelf: event.creator?.self === true,
    otherAttendees: (event.attendees ?? []).filter((attendee) => attendee.self !== true && attendee.resource !== true).length,
    url: event.htmlLink ?? "",
  });
}
