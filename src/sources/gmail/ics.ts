import { DateTime, Option } from "effect";

/** 招待の予定がいつ終わるか。open は終わりが決まっていない（終わりのない繰り返し・読めない）もの */
export type InviteEnd = { kind: "ends"; at: number } | { kind: "open" } | { kind: "cancelled" };

const OPEN: InviteEnd = { kind: "open" };

/** 折り返された行（RFC 5545 で 75 文字ごとに改行し、続きを空白で始める）をつなげる */
const unfold = (text: string) => text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/** DTSTART;TZID=Asia/Tokyo:20261120T100000 のような行の値を、ミリ秒にする。読めなければ none */
const instantOf = (line: string): Option.Option<number> => {
  const separator = line.indexOf(":");
  if (separator === -1) return Option.none();
  const params = line.slice(0, separator).split(";").slice(1);
  const match = DATE_TIME.exec(line.slice(separator + 1).trim());
  if (match === null) return Option.none();
  const [, year, month, day, hours = "0", minutes = "0", seconds = "0", utc] = match;
  const parts = { year: Number(year), month: Number(month), day: Number(day), hour: Number(hours), minute: Number(minutes), second: Number(seconds) };
  const tzid = params.find((param) => param.startsWith("TZID="))?.slice("TZID=".length);
  if (utc === "Z" || tzid === undefined) return Option.some(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  const zone = DateTime.zoneMakeNamed(tzid);
  if (Option.isNone(zone)) return Option.none();
  return DateTime.makeZoned(parts, { timeZone: zone.value, adjustForTimeZone: true }).pipe(Option.map(DateTime.toEpochMillis));
};

/** 招待のファイル（iCalendar）から、予定がいつ終わるかを読む。繰り返しは最後の回（UNTIL）まで終わらない */
export function inviteEndOf(ics: string): InviteEnd {
  const lines = unfold(ics);
  if (lines.some((line) => line.trim().toUpperCase() === "METHOD:CANCEL")) return { kind: "cancelled" };
  const begin = lines.indexOf("BEGIN:VEVENT");
  const end = lines.indexOf("END:VEVENT", begin);
  if (begin === -1 || end === -1) return OPEN;
  const event = lines.slice(begin + 1, end);
  const field = (name: string) => event.find((line) => line.startsWith(`${name}:`) || line.startsWith(`${name};`));

  const rrule = field("RRULE");
  if (rrule !== undefined) {
    const until = /(?:^|;|:)UNTIL=([0-9TZ]+)/.exec(rrule)?.[1];
    return until === undefined ? OPEN : Option.match(instantOf(`UNTIL:${until}`), { onNone: () => OPEN, onSome: (at) => ({ kind: "ends", at }) });
  }
  const last = field("DTEND") ?? field("DTSTART");
  if (last === undefined) return OPEN;
  return Option.match(instantOf(last), { onNone: () => OPEN, onSome: (at) => ({ kind: "ends", at }) });
}
