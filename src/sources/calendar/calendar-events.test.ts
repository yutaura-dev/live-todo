import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { eventFrom } from "./calendar-events.js";

const calendar = { id: "me@example.com", name: "自分", timeZone: "Asia/Tokyo", primary: true };
const raw = {
  id: "ev1",
  status: "confirmed",
  eventType: "default",
  summary: "設計レビュー",
  description: "資料を事前に読んでおいてください",
  htmlLink: "https://www.google.com/calendar/event?eid=abc",
  start: { dateTime: "2025-11-27T10:00:00+09:00", timeZone: "Asia/Tokyo" },
  end: { dateTime: "2025-11-27T11:00:00+09:00", timeZone: "Asia/Tokyo" },
  creator: { email: "boss@example.com" },
  organizer: { email: "boss@example.com" },
  attendees: [
    { email: "me@example.com", self: true, responseStatus: "needsAction" },
    { email: "boss@example.com", organizer: true, responseStatus: "accepted" },
    { email: "room@resource.calendar.google.com", resource: true, responseStatus: "accepted" },
  ],
};

describe("eventFrom（Calendar の予定を扱いやすい形にする）", () => {
  it("時刻のある予定は、開始と終わりの時刻・カレンダーのタイムゾーンでの日時の表示・自分の出欠・ほかの参加者の数（会議室は数えない）にする", () => {
    const event = Option.getOrThrow(eventFrom(raw, calendar));

    assert.deepInclude(event, {
      key: "me@example.com:ev1",
      summary: "設計レビュー",
      allDay: false,
      startMs: Date.parse("2025-11-27T01:00:00Z"),
      endMs: Date.parse("2025-11-27T02:00:00Z"),
      startLabel: "11/27 10:00",
      selfResponse: "needsAction",
      organizerSelf: false,
      creatorSelf: false,
      otherAttendees: 1,
      cancelled: false,
      url: "https://www.google.com/calendar/event?eid=abc",
    });
  });

  it("終日の予定は、カレンダーのタイムゾーンのその日の 0 時から、終わりの日（含まない）の 0 時までにする", () => {
    const event = Option.getOrThrow(
      eventFrom({ ...raw, attendees: undefined, creator: { self: true }, organizer: { self: true }, start: { date: "2025-11-28" }, end: { date: "2025-11-29" } }, calendar),
    );

    assert.deepInclude(event, {
      allDay: true,
      startMs: Date.parse("2025-11-27T15:00:00Z"),
      endMs: Date.parse("2025-11-28T15:00:00Z"),
      startLabel: "11/28",
      selfResponse: undefined,
      organizerSelf: true,
      creatorSelf: true,
      otherAttendees: 0,
    });
  });

  it("取り消された予定は cancelled にする（消された予定は開始・終わりがないこともある）", () => {
    const event = eventFrom({ id: "ev2", status: "cancelled" }, calendar);

    assert.isTrue(Option.isSome(event) && event.value.cancelled);
  });

  it("形の分からない予定は none", () => {
    assert.isTrue(Option.isNone(eventFrom({ status: "confirmed" }, calendar)));
    assert.isTrue(Option.isNone(eventFrom({ ...raw, start: { dateTime: "x" } }, calendar)));
  });
});
