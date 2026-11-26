import { assert, describe, it } from "@effect/vitest";
import { inviteEndOf } from "./ics.js";

const ics = (...event: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Tokyo",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    ...event,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

describe("inviteEndOf（招待の予定がいつ終わるか）", () => {
  it("タイムゾーンつきの終わりの日時を読む（時差の定義の中の DTSTART は見ない）", () => {
    const end = inviteEndOf(ics("DTSTART;TZID=Asia/Tokyo:20261120T100000", "DTEND;TZID=Asia/Tokyo:20261120T110000"));
    assert.deepStrictEqual(end, { kind: "ends", at: Date.UTC(2026, 10, 20, 2, 0, 0) });
  });

  it("UTC の日時と、終日の予定（日付だけ。終わりの日は含まない）を読む", () => {
    assert.deepStrictEqual(inviteEndOf(ics("DTSTART:20261120T010000Z", "DTEND:20261120T020000Z")), { kind: "ends", at: Date.UTC(2026, 10, 20, 2) });
    assert.deepStrictEqual(inviteEndOf(ics("DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261121")), { kind: "ends", at: Date.UTC(2026, 10, 21) });
  });

  it("終わりがなければ始まりの日時を使う", () => {
    assert.deepStrictEqual(inviteEndOf(ics("DTSTART:20261120T010000Z")), { kind: "ends", at: Date.UTC(2026, 10, 20, 1) });
  });

  it("繰り返しの予定は、最後の回（UNTIL）まで終わらない。終わりのない繰り返しは過ぎない", () => {
    assert.deepStrictEqual(inviteEndOf(ics("DTSTART:20261120T010000Z", "DTEND:20261120T020000Z", "RRULE:FREQ=WEEKLY;UNTIL=20261231T145959Z")), { kind: "ends", at: Date.UTC(2026, 11, 31, 14, 59, 59) });
    assert.deepStrictEqual(inviteEndOf(ics("DTSTART:20261120T010000Z", "RRULE:FREQ=WEEKLY")), { kind: "open" });
    assert.deepStrictEqual(inviteEndOf(ics("DTSTART:20261120T010000Z", "RRULE:FREQ=WEEKLY;COUNT=5")), { kind: "open" });
  });

  it("取り消された予定（METHOD:CANCEL）は、日程に関わらず片付けてよいものにする", () => {
    assert.deepStrictEqual(inviteEndOf(ics("DTSTART:20991120T010000Z").replace("METHOD:REQUEST", "METHOD:CANCEL")), { kind: "cancelled" });
  });

  it("読めない予定は、過ぎないものとして扱う（勝手に片付けを勧めない）", () => {
    assert.deepStrictEqual(inviteEndOf("garbage"), { kind: "open" });
    assert.deepStrictEqual(inviteEndOf(ics("DTSTART;TZID=Nowhere/Unknown:20261120T100000")), { kind: "open" });
  });

  it("折り返された行（次の行が空白で始まる）をつなげて読む", () => {
    assert.deepStrictEqual(inviteEndOf(ics("DTSTART:20261120T010000Z", "RRULE:FREQ=WEEKLY;", " UNTIL=20261231T145959Z")), { kind: "ends", at: Date.UTC(2026, 11, 31, 14, 59, 59) });
  });
});
