import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Duration, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { EnvSecretStore } from "../core/config/secret-store.js";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../core/db/test-database.js";
import { StructuredClassifier } from "../core/judge/todo-judge.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { CalendarClient } from "../sources/calendar/calendar-client.js";
import { decodeAppConfig } from "./config/app-config.js";
import { makeCalendarJobs, runCalendarSync } from "./calendar-jobs.js";

const account = Effect.gen(function* () {
  const config = yield* decodeAppConfig({
    llmProfiles: { work: { provider: "none", model: "-", decisions: { provider: "openai" } } },
    defaultLlmProfile: "work",
    accounts: [],
    gmailAccounts: [{ kind: "gmail", id: "mail", calendar: true }],
  });
  return config.gmailAccounts[0]!;
});

const invite = (id: string) => ({
  id,
  status: "confirmed",
  summary: `定例 ${id}`,
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
  start: { dateTime: "2025-11-27T10:00:00+09:00" },
  end: { dateTime: "2025-11-27T11:00:00+09:00" },
  attendees: [{ self: true, responseStatus: "needsAction" }, { email: "boss@example.com", responseStatus: "accepted" }],
});

describe("runCalendarSync", () => {
  it.effect("書き込めるカレンダーごとに前日から 1 か月先までの予定を 1 度だけ取り、3 つの Source に反映する", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2025-11-26T00:00:00.000Z"));
      const ranges: string[] = [];
      const client = CalendarClient.of({
        writableCalendars: Effect.succeed([
          { id: "me@example.com", name: "自分", timeZone: "Asia/Tokyo", primary: true },
          { id: "team", name: "チーム", timeZone: "Asia/Tokyo", primary: false },
        ]),
        events: (calendarId, range) =>
          Effect.sync(() => {
            ranges.push(`${calendarId} ${range.timeMin} ${range.timeMax}`);
            return calendarId === "team" ? [invite("b"), { broken: true }] : [invite("a")];
          }),
      });

      yield* runCalendarSync({ accountId: "cal" }).pipe(
        Effect.provideService(CalendarClient, client),
        Effect.provideService(StructuredClassifier, StructuredClassifier.of({ classifyTodo: () => Effect.succeed({ verdict: "todo" }) })),
      );

      assert.deepStrictEqual(ranges, ["me@example.com 2025-11-25T00:00:00.000Z 2025-12-27T00:00:00.000Z", "team 2025-11-25T00:00:00.000Z 2025-12-27T00:00:00.000Z"]);
      const tasks = yield* (yield* TaskRepository).listTasks;
      assert.deepStrictEqual(tasks.map((task) => [task.title, task.status]).toSorted(), [
        ["出欠を返す: 定例 a（11/27 10:00）", "todo"],
        ["出欠を返す: 定例 b（11/27 10:00）", "todo"],
      ]);
    }).pipe(Effect.provide(TestDatabase)));
});

describe("makeCalendarJobs", () => {
  it.effect("Calendar も見る Gmail のアカウントごとに、5 分おきの同期のジョブを 1 つ作る（Source 名は Gmail のアカウントの id）", () =>
    Effect.gen(function* () {
      const jobs = yield* makeCalendarJobs(yield* account);

      assert.deepStrictEqual(jobs.map((job) => [job.name, Duration.toMillis(job.interval)]), [["calendar:mail", Duration.toMillis("5 minutes")]]);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")))))),
      Effect.provide(EnvSecretStore),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { LIVE_TODO_SECRET_LLM_OPENAI_API_KEY: "sk-test" } })),
    ));
});
