import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { outlookEventFrom } from "./outlook-calendar.js";

const me = { address: "me@contoso.com", timeZone: "Asia/Tokyo" };
const raw = {
  id: "AAMk1",
  subject: "設計レビュー",
  bodyPreview: "資料を事前に読んでおいてください",
  isAllDay: false,
  isCancelled: false,
  isOrganizer: false,
  showAs: "busy",
  responseRequested: true,
  webLink: "https://outlook.office365.com/owa/?itemid=AAMk1",
  start: { dateTime: "2025-11-27T01:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2025-11-27T02:00:00.0000000", timeZone: "UTC" },
  responseStatus: { response: "notResponded" },
  organizer: { emailAddress: { address: "boss@contoso.com" } },
  attendees: [
    { type: "required", emailAddress: { address: "me@contoso.com" }, status: { response: "none" } },
    { type: "required", emailAddress: { address: "Boss@contoso.com" }, status: { response: "accepted" } },
    { type: "resource", emailAddress: { address: "room@contoso.com" }, status: { response: "accepted" } },
  ],
};

describe("outlookEventFrom（Outlook の予定を Calendar の予定と同じ形にする）", () => {
  it("UTC の時刻・出欠（未回答は needsAction）・ほかの参加者の数（自分と会議室は数えない）・予定のリンクにする", () => {
    const event = Option.getOrThrow(outlookEventFrom(raw, me));

    assert.deepInclude(event, {
      key: "outlook:AAMk1",
      summary: "設計レビュー",
      description: "資料を事前に読んでおいてください",
      allDay: false,
      startMs: Date.parse("2025-11-27T01:00:00Z"),
      endMs: Date.parse("2025-11-27T02:00:00Z"),
      startLabel: "11/27 10:00",
      selfResponse: "needsAction",
      organizerSelf: false,
      creatorSelf: false,
      otherAttendees: 1,
      cancelled: false,
      eventType: "default",
      url: "https://outlook.office365.com/owa/?itemid=AAMk1",
    });
  });

  it("出欠の返事の種類を Calendar の言い方にそろえ、返事を求められていない予定は未回答にしない", () => {
    const response = (value: string, extra: object = {}) => Option.getOrThrow(outlookEventFrom({ ...raw, ...extra, responseStatus: { response: value } }, me)).selfResponse;

    assert.deepStrictEqual(
      [response("accepted"), response("tentativelyAccepted"), response("declined"), response("organizer"), response("notResponded", { responseRequested: false })],
      ["accepted", "tentative", "declined", undefined, undefined],
    );
  });

  it("自分が主催なら、主催かつ自分で入れた予定にする。不在（oof）の予定は default にしない", () => {
    const event = Option.getOrThrow(outlookEventFrom({ ...raw, isOrganizer: true, showAs: "oof", responseStatus: { response: "organizer" } }, me));

    assert.deepInclude(event, { organizerSelf: true, creatorSelf: true, eventType: "outOfOffice" });
  });

  it("終日の予定は、日付をタイムゾーンのその日の 0 時からとする", () => {
    const event = Option.getOrThrow(
      outlookEventFrom({ ...raw, isAllDay: true, start: { dateTime: "2025-11-28T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2025-11-29T00:00:00.0000000", timeZone: "UTC" } }, me),
    );

    assert.deepInclude(event, { allDay: true, startMs: Date.parse("2025-11-27T15:00:00Z"), endMs: Date.parse("2025-11-28T15:00:00Z"), startLabel: "11/28" });
  });

  it("取り消された予定は cancelled にし、形の分からない予定は none", () => {
    assert.isTrue(Option.getOrThrow(outlookEventFrom({ ...raw, isCancelled: true }, me)).cancelled);
    assert.isTrue(Option.isNone(outlookEventFrom({ subject: "x" }, me)));
  });
});
