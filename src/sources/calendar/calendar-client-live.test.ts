import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Gws } from "../gmail/gmail-client-live.js";
import { CalendarClient } from "./calendar-client.js";
import { CalendarClientLive } from "./calendar-client-live.js";

/** 受け取った引数を記録し、応答を返す偽の gws */
const fakeGws = (reply: (args: ReadonlyArray<string>) => { exitCode?: number; body: unknown }) => {
  const calls: ReadonlyArray<string>[] = [];
  const layer = CalendarClientLive.pipe(
    Layer.provide(
      Layer.succeed(
        Gws,
        Gws.of({
          run: (args) =>
            Effect.sync(() => {
              calls.push(args);
              const result = reply(args);
              return { exitCode: result.exitCode ?? 0, stdout: JSON.stringify(result.body) };
            }),
        }),
      ),
    ),
  );
  return { calls, layer };
};

const withClient = <A, E>(layer: Layer.Layer<CalendarClient>, use: (client: CalendarClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* CalendarClient);
  }).pipe(Effect.provide(layer));

const paramsOf = (args: ReadonlyArray<string>) => JSON.parse(args[args.indexOf("--params") + 1]!);

describe("CalendarClientLive", () => {
  it.effect("書き込めるカレンダー（owner・writer）の一覧を、名前とタイムゾーンつきで返す", () =>
    Effect.gen(function* () {
      const { calls, layer } = fakeGws(() => ({
        body: {
          items: [
            { id: "me@example.com", summary: "自分", timeZone: "Asia/Tokyo", primary: true, accessRole: "owner" },
            { id: "team@group.calendar.google.com", summary: "チーム", timeZone: "Asia/Tokyo", accessRole: "writer" },
          ],
        },
      }));

      const calendars = yield* withClient(layer, (client) => client.writableCalendars);

      assert.deepStrictEqual(calls[0]?.slice(0, 4), ["calendar", "calendarList", "list", "--params"]);
      assert.deepInclude(paramsOf(calls[0]!), { minAccessRole: "writer" });
      assert.deepStrictEqual(calendars, [
        { id: "me@example.com", name: "自分", timeZone: "Asia/Tokyo", primary: true },
        { id: "team@group.calendar.google.com", name: "チーム", timeZone: "Asia/Tokyo", primary: false },
      ]);
    }));

  it.effect("予定は、繰り返しを展開し、取り消された予定も含めて、範囲の中を取る", () =>
    Effect.gen(function* () {
      const { calls, layer } = fakeGws(() => ({ body: { items: [{ id: "ev1" }] } }));

      const events = yield* withClient(layer, (client) => client.events("me@example.com", { timeMin: "2025-11-25T00:00:00.000Z", timeMax: "2025-12-26T00:00:00.000Z" }));

      assert.deepStrictEqual(calls[0]?.slice(0, 3), ["calendar", "events", "list"]);
      assert.deepInclude(paramsOf(calls[0]!), {
        calendarId: "me@example.com",
        timeMin: "2025-11-25T00:00:00.000Z",
        timeMax: "2025-12-26T00:00:00.000Z",
        singleEvents: true,
        showDeleted: true,
      });
      assert.deepStrictEqual(events, [{ id: "ev1" }]);
    }));

  it.effect("gws が失敗したら、Calendar の権限を確かめるよう促す失敗にする", () =>
    Effect.gen(function* () {
      const { layer } = fakeGws(() => ({ exitCode: 1, body: { error: { code: 403, message: "Insufficient Permission" } } }));

      const error = yield* withClient(layer, (client) => client.writableCalendars).pipe(Effect.flip);

      assert.strictEqual(error._tag, "CalendarRequestError");
      assert.include(error.message, "403");
      assert.include(error.message, "Calendar");
    }));
});
