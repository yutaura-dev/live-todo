import { Effect, Layer, Option, Schema } from "effect";
import { Gws } from "../gmail/gmail-client-live.js";
import { CalendarClient, CalendarRequestError } from "./calendar-client.js";

// 1 回に取る予定の上限（API の最大）。範囲は 1 か月ほどなので、ふつうは 1 ページに収まる
const MAX_RESULTS = 250;

const CalendarList = Schema.Struct({
  items: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, summary: Schema.optional(Schema.String), timeZone: Schema.optional(Schema.String), primary: Schema.optional(Schema.Boolean) })),
  ),
});
const EventList = Schema.Struct({ items: Schema.optional(Schema.Array(Schema.Unknown)), nextPageToken: Schema.optional(Schema.String) });
const ErrorBody = Schema.Struct({ error: Schema.Struct({ code: Schema.Number }) });

export const CalendarClientLive = Layer.effect(
  CalendarClient,
  Effect.gen(function* () {
    const gws = yield* Gws;
    const call = <S extends Schema.Decoder<unknown>>(args: ReadonlyArray<string>, schema: S, what: string) =>
      Effect.gen(function* () {
        const result = yield* gws.run(args).pipe(Effect.mapError((error) => new CalendarRequestError({ message: error.message })));
        if (result.exitCode !== 0) {
          const code = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))(result.stdout))?.error.code;
          return yield* new CalendarRequestError({
            message: `Calendar の${what}を取れない（${code ?? `終了コード ${result.exitCode}`}）。gws の認証に Calendar の権限があるか確かめてください`,
          });
        }
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(result.stdout).pipe(
          Effect.mapError(() => new CalendarRequestError({ message: `Calendar の${what}の応答を読めない` })),
        );
      });

    return CalendarClient.of({
      writableCalendars: call(["calendar", "calendarList", "list", "--params", JSON.stringify({ minAccessRole: "writer", maxResults: MAX_RESULTS })], CalendarList, "一覧").pipe(
        Effect.map((body) =>
          (body.items ?? []).map((item) => ({ id: item.id, name: item.summary ?? item.id, timeZone: item.timeZone ?? "UTC", primary: item.primary === true })),
        ),
      ),
      events: (calendarId, range) =>
        call(
          [
            "calendar",
            "events",
            "list",
            "--params",
            JSON.stringify({ calendarId, timeMin: range.timeMin, timeMax: range.timeMax, singleEvents: true, showDeleted: true, orderBy: "startTime", maxResults: MAX_RESULTS }),
          ],
          EventList,
          "予定",
        ).pipe(
          Effect.tap((body) =>
            body.nextPageToken === undefined ? Effect.void : Effect.logWarning("Calendar の予定が 1 ページに収まらなかった。残りは取らない").pipe(Effect.annotateLogs({ calendarId })),
          ),
          Effect.map((body) => body.items ?? []),
        ),
    });
  }),
);
