import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { StructuredClassifier, type JudgeRequest } from "../../core/judge/todo-judge.js";
import { type CalendarCursor, makeCalendarBindings } from "./calendar-bindings.js";
import type { CalendarEvent } from "./calendar-events.js";

const NOW = Date.parse("2025-11-26T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  key: "me@example.com:ev",
  calendarId: "me@example.com",
  calendarName: "自分",
  eventId: "ev",
  summary: "設計レビュー",
  description: "",
  cancelled: false,
  eventType: "default",
  allDay: false,
  startMs: NOW + DAY,
  endMs: NOW + DAY + HOUR,
  startLabel: "11/27 09:00",
  selfResponse: "accepted",
  organizerSelf: false,
  creatorSelf: false,
  otherAttendees: 2,
  url: "https://www.google.com/calendar/event?eid=ev",
  ...overrides,
});

const run = (events: ReadonlyArray<CalendarEvent>, cursors: Partial<Record<"invites" | "prep" | "todos", CalendarCursor>> = {}, at = NOW) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const bindings = yield* makeCalendarBindings({ accountId: "cal", events });
    const fetch = (name: "invites" | "prep" | "todos") =>
      Effect.map(bindings[name].adapter.fetchChanges(cursors[name] ?? null), (result) => ({
        ...result,
        drafts: result.changes.map((change) =>
          change.kind === "upserted" ? ([bindings[name].externalIdOf(change.item), bindings[name].toItemDraft(change.item).title, bindings[name].toItemDraft(change.item).state] as const) : (["removed", change.externalId] as const),
        ),
      }));
    return { bindings, invites: yield* fetch("invites"), prep: yield* fetch("prep"), todos: yield* fetch("todos") };
  });

const judgeWith = (answer: unknown) => {
  const requests: JudgeRequest[] = [];
  const classifier = StructuredClassifier.of({
    classifyTodo: (request) => {
      requests.push(request);
      return Effect.succeed(answer);
    },
  });
  return { requests, classifier };
};

describe("Calendar の Source", () => {
  it.effect("Source はアカウントごとに、出欠・準備・自分の todo の 3 つに分ける", () =>
    Effect.gen(function* () {
      const { bindings } = yield* run([]);

      assert.deepStrictEqual([bindings.invites.source, bindings.prep.source, bindings.todos.source], ["calendar:cal:invites", "calendar:cal:prep", "calendar:cal:todos"]);
    }));

  describe("出欠が未回答の招待", () => {
    it.effect("自分の出欠が未回答で、まだ終わっていない予定を「出欠を返す」の項目にし、規則で todo にする", () =>
      Effect.gen(function* () {
        const { bindings, invites } = yield* run([event({ selfResponse: "needsAction" }), event({ key: "k2", selfResponse: "needsAction", endMs: NOW - HOUR, startMs: NOW - 2 * HOUR })]);

        assert.deepStrictEqual(invites.drafts, [["me@example.com:ev", "出欠を返す: 設計レビュー（11/27 09:00）", "open"]]);
        const change = invites.changes[0]!;
        if (change.kind !== "upserted") return assert.fail("出欠の項目がない");
        assert.deepStrictEqual(yield* bindings.invites.judge(change.item), { verdict: "todo", method: "rule" });
      }));

    it.effect("出欠を返したら、済んだことにする", () =>
      Effect.gen(function* () {
        const first = yield* run([event({ selfResponse: "needsAction" })]);
        const second = yield* run([event({ selfResponse: "declined" })], { invites: first.invites.nextCursor });

        assert.deepStrictEqual(second.invites.drafts, [["me@example.com:ev", "出欠を返す: 設計レビュー（11/27 09:00）", "resolved"]]);
      }));

    it.effect("予定が取り消されたら済んだことにし、まだ先の予定が見えなくなったら（消されたら）removed にする", () =>
      Effect.gen(function* () {
        const first = yield* run([event({ selfResponse: "needsAction" }), event({ key: "k2", selfResponse: "needsAction" })]);
        const second = yield* run([event({ selfResponse: "needsAction", cancelled: true })], { invites: first.invites.nextCursor });

        assert.deepStrictEqual(second.invites.drafts, [
          ["me@example.com:ev", "出欠を返す: 設計レビュー（11/27 09:00）", "resolved"],
          ["removed", "k2"],
        ]);
      }));

    it.effect("時間が過ぎて取得の範囲から出ただけの予定は、前の状態のまま覚えておく", () =>
      Effect.gen(function* () {
        const first = yield* run([event({ selfResponse: "needsAction", startMs: NOW + HOUR, endMs: NOW + 2 * HOUR })]);
        const later = yield* run([], { invites: first.invites.nextCursor }, NOW + 3 * DAY);

        assert.deepStrictEqual(later.invites.drafts, []);
        assert.property(later.invites.nextCursor.items, "me@example.com:ev");
      }));

    it.effect("30 日より前に終わった予定は、覚えるのをやめる", () =>
      Effect.gen(function* () {
        const first = yield* run([event({ selfResponse: "needsAction" })]);
        const later = yield* run([], { invites: first.invites.nextCursor }, NOW + 40 * DAY);

        assert.deepStrictEqual(later.invites.nextCursor.items, {});
      }));

    it.effect("自分が主催の予定は、出欠の項目にしない", () =>
      Effect.gen(function* () {
        const { invites } = yield* run([event({ selfResponse: "needsAction", organizerSelf: true })]);

        assert.deepStrictEqual(invites.drafts, []);
      }));
  });

  describe("準備が要る予定", () => {
    it.effect("3 日以内に始まり、自分が出る、ほかの人がいる時刻の予定を「準備」の項目にする。未回答・辞退・終日・ほかの人がいない予定は除く", () =>
      Effect.gen(function* () {
        const { prep } = yield* run([
          event({}),
          event({ key: "far", startMs: NOW + 4 * DAY, endMs: NOW + 4 * DAY + HOUR }),
          event({ key: "na", selfResponse: "needsAction" }),
          event({ key: "no", selfResponse: "declined" }),
          event({ key: "allday", allDay: true }),
          event({ key: "alone", otherAttendees: 0, selfResponse: undefined, organizerSelf: true }),
          event({ key: "host", selfResponse: undefined, organizerSelf: true }),
        ]);

        assert.deepStrictEqual(prep.drafts.map(([id, title]) => [id, title]), [
          ["me@example.com:ev", "準備: 設計レビュー（11/27 09:00）"],
          ["host", "準備: 設計レビュー（11/27 09:00）"],
        ]);
      }));

    it.effect("予定が終わったら、済んだことにする", () =>
      Effect.gen(function* () {
        const first = yield* run([event({ startMs: NOW + HOUR, endMs: NOW + 2 * HOUR })]);
        const later = yield* run([event({ startMs: NOW + HOUR, endMs: NOW + 2 * HOUR })], { prep: first.prep.nextCursor }, NOW + 3 * HOUR);

        assert.deepStrictEqual(later.prep.drafts.map(([, , state]) => state), ["resolved"]);
      }));

    it.effect("準備が要るかは、予定の名前と説明を、出欠・主催・参加者の数を添えて LLM で判定する", () =>
      Effect.gen(function* () {
        const { bindings, prep } = yield* run([event({ description: "資料を事前に読んでおいてください" })]);
        const { requests, classifier } = judgeWith({ verdict: "todo" });
        const change = prep.changes[0]!;
        if (change.kind !== "upserted") return assert.fail("準備の項目がない");

        const judgment = yield* bindings.prep.judge(change.item).pipe(Effect.provideService(StructuredClassifier, classifier));

        assert.strictEqual(judgment.verdict, "todo");
        assert.include(requests[0]?.input ?? "", "資料を事前に読んでおいてください");
        assert.include(requests[0]?.context ?? "", "参加者: 自分のほかに 2 人");
        assert.include(requests[0]?.context ?? "", "11/27 09:00");
      }));
  });

  describe("自分で入れた予定の todo", () => {
    const mine = (overrides: Partial<CalendarEvent>) => event({ creatorSelf: true, organizerSelf: true, selfResponse: undefined, otherAttendees: 0, ...overrides });

    it.effect("自分で入れた、ほかの人のいない予定のうち、説明に TODO の印があるものと終日のものを、前日から項目にする", () =>
      Effect.gen(function* () {
        const { todos } = yield* run([
          mine({ key: "marked", summary: "請求書", description: "TODO: 送る" }),
          mine({ key: "allday", summary: "確定申告", allDay: true, startLabel: "11/26", startMs: NOW, endMs: NOW + DAY }),
          mine({ key: "plain", summary: "ジム" }),
          mine({ key: "later", summary: "年賀状", allDay: true, startMs: NOW + 3 * DAY, endMs: NOW + 4 * DAY }),
          event({ key: "others", description: "TODO: 送る" }),
        ]);

        assert.deepStrictEqual(todos.drafts, [
          ["marked", "請求書（11/27 09:00）", "open"],
          ["allday", "確定申告（11/26）", "open"],
        ]);
      }));

    it.effect("日が過ぎても済んだことにはしない（自分でやるまで残す）", () =>
      Effect.gen(function* () {
        const first = yield* run([mine({ description: "TODO: 送る" })]);
        const later = yield* run([mine({ description: "TODO: 送る" })], { todos: first.todos.nextCursor }, NOW + 2 * DAY);

        assert.deepStrictEqual(later.todos.drafts, []);
      }));

    it.effect("TODO の印があれば規則で todo、終日の予定だけなら休みや記念日でないかを LLM で判定する", () =>
      Effect.gen(function* () {
        const { bindings, todos } = yield* run([mine({ key: "marked", description: "TODO: 送る" }), mine({ key: "allday", summary: "有給", allDay: true, startMs: NOW, endMs: NOW + DAY })]);
        const { requests, classifier } = judgeWith({ verdict: "not_todo" });
        const items = todos.changes.flatMap((change) => (change.kind === "upserted" ? [change.item] : []));

        const judgments = yield* Effect.forEach(items, (item) => bindings.todos.judge(item).pipe(Effect.provideService(StructuredClassifier, classifier)));

        assert.deepStrictEqual(judgments.map((judgment) => [judgment.verdict, judgment.method]), [
          ["todo", "rule"],
          ["not_todo", "structured"],
        ]);
        assert.strictEqual(requests.length, 1);
        assert.include(requests[0]?.input ?? "", "有給");
      }));
  });
});
