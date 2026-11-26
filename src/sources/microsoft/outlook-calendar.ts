import { DateTime, Option, Schema } from "effect";
import { type CalendarEvent, labelOf, localMidnight, type SelfResponse } from "../calendar/calendar-events.js";

const Time = Schema.Struct({ dateTime: Schema.String, timeZone: Schema.String });
const Address = Schema.Struct({ emailAddress: Schema.optional(Schema.Struct({ address: Schema.optional(Schema.String) })) });
const RawEvent = Schema.Struct({
  id: Schema.String,
  subject: Schema.optional(Schema.NullOr(Schema.String)),
  bodyPreview: Schema.optional(Schema.NullOr(Schema.String)),
  isAllDay: Schema.optional(Schema.Boolean),
  isCancelled: Schema.optional(Schema.Boolean),
  isOrganizer: Schema.optional(Schema.Boolean),
  showAs: Schema.optional(Schema.String),
  responseRequested: Schema.optional(Schema.Boolean),
  webLink: Schema.optional(Schema.String),
  start: Time,
  end: Time,
  responseStatus: Schema.optional(Schema.Struct({ response: Schema.optional(Schema.String) })),
  attendees: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String), ...Address.fields }))),
});
const decodeRawEvent = Schema.decodeUnknownOption(RawEvent);

const RESPONSES: Readonly<Record<string, SelfResponse>> = { notResponded: "needsAction", accepted: "accepted", tentativelyAccepted: "tentative", declined: "declined" };
// 7 桁の小数秒（"2025-11-27T01:00:00.0000000"）は ISO として読めないことがあるので、秒までにする
const toUtcEpoch = (time: typeof Time.Type) =>
  time.timeZone === "UTC" ? Option.map(DateTime.make(`${time.dateTime.slice(0, 19)}Z`), DateTime.toEpochMillis) : Option.none<number>();

/**
 * Graph の予定（Prefer: outlook.timezone="UTC" で取ったもの）を、Calendar の予定と同じ形にする（ADR-0017）。
 * 終日の予定は日付だけを使い、timeZone のその日の 0 時からとする。Graph には作った人がないので、主催なら自分で入れた予定とみなす
 */
export function outlookEventFrom(raw: unknown, me: { address: string; timeZone: string }): Option.Option<CalendarEvent> {
  const decoded = decodeRawEvent(raw);
  if (Option.isNone(decoded)) return Option.none();
  const event = decoded.value;
  const allDay = event.isAllDay === true;
  const start = allDay ? localMidnight(event.start.dateTime.slice(0, 10), me.timeZone) : toUtcEpoch(event.start);
  const end = allDay ? localMidnight(event.end.dateTime.slice(0, 10), me.timeZone) : toUtcEpoch(event.end);
  if (Option.isNone(start) || Option.isNone(end)) return Option.none();
  const myAddress = me.address.toLowerCase();
  const response = event.responseStatus?.response;
  const organizer = event.isOrganizer === true;
  return Option.some({
    key: `outlook:${event.id}`,
    calendarId: "outlook",
    calendarName: "Outlook",
    eventId: event.id,
    summary: event.subject?.trim() || "（無題の予定）",
    description: event.bodyPreview ?? "",
    cancelled: event.isCancelled === true,
    eventType: event.showAs === "oof" ? "outOfOffice" : "default",
    allDay,
    startMs: start.value,
    endMs: end.value,
    startLabel: labelOf(start.value, allDay, me.timeZone),
    selfResponse: organizer || response === undefined || (response === "notResponded" && event.responseRequested === false) ? undefined : RESPONSES[response],
    organizerSelf: organizer,
    creatorSelf: organizer,
    otherAttendees: (event.attendees ?? []).filter((attendee) => attendee.type !== "resource" && attendee.emailAddress?.address?.toLowerCase() !== myAddress).length,
    url: event.webLink ?? "",
  });
}
