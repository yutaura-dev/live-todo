import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../core/db/test-database.js";
import { StructuredClassifier } from "../core/judge/todo-judge.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { GraphClient } from "../sources/microsoft/graph-client.js";
import { microsoftScopes, runOutlookCalendarSync } from "./microsoft-jobs.js";

const invite = {
  id: "AAMk1",
  subject: "定例",
  isAllDay: false,
  isCancelled: false,
  isOrganizer: false,
  responseRequested: true,
  webLink: "https://outlook.office365.com/owa/?itemid=AAMk1",
  start: { dateTime: "2025-11-27T01:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2025-11-27T02:00:00.0000000", timeZone: "UTC" },
  responseStatus: { response: "notResponded" },
  attendees: [{ type: "required", emailAddress: { address: "boss@contoso.com" } }],
};

describe("microsoftScopes", () => {
  it("リフレッシュトークンとユーザーの確認に要る権限に、使う機能の読み取りの権限を足す", () => {
    assert.deepStrictEqual(microsoftScopes({ calendar: false }), ["offline_access", "User.Read"]);
    assert.deepStrictEqual(microsoftScopes({ calendar: true }), ["offline_access", "User.Read", "Calendars.Read"]);
  });
});

describe("runOutlookCalendarSync", () => {
  it.effect("自分のアドレスを確かめ、前日から 1 か月先までの予定を UTC で取り、Outlook の 3 つの Source に反映する", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2025-11-26T00:00:00.000Z"));
      const calls: string[] = [];
      const graph = GraphClient.of({
        get: (path) => Effect.sync(() => (calls.push(`get ${path}`), { mail: "me@contoso.com", userPrincipalName: "me@contoso.com" })),
        getAll: (path, options) =>
          Effect.sync(() => {
            calls.push(`getAll ${path} ${options?.query?.["startDateTime"]} ${options?.query?.["endDateTime"]} ${options?.headers?.["prefer"]}`);
            return [invite, { broken: true }];
          }),
      });

      yield* runOutlookCalendarSync({ accountId: "corp", timeZone: "Asia/Tokyo" }).pipe(
        Effect.provideService(GraphClient, graph),
        Effect.provideService(StructuredClassifier, StructuredClassifier.of({ classifyTodo: () => Effect.succeed({ verdict: "todo" }) })),
      );

      assert.deepStrictEqual(calls, ["get /me", 'getAll /me/calendarView 2025-11-25T00:00:00.000Z 2025-12-27T00:00:00.000Z outlook.timezone="UTC"']);
      const tasks = yield* (yield* TaskRepository).listTasks;
      assert.deepStrictEqual(tasks.map((task) => [task.title, task.status]), [["出欠を返す: 定例（11/27 10:00）", "todo"]]);
    }).pipe(Effect.provide(TestDatabase)));
});
