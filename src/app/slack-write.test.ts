import { assert, describe, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Database } from "../core/db/database.js";
import { approvals } from "../core/db/schema.js";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { SlackRequestError } from "../sources/slack/slack-client.js";
import { slackClientStub } from "../sources/slack/test-client.js";
import { slackWrite } from "./slack-write.js";

const slackTask = (source = "slack:home") =>
  Effect.gen(function* () {
    const item = yield* (yield* SourceItemRepository).upsertItem({
      source,
      externalId: "C0123ABCD:1764000000.123456",
      title: "#general: 請求書を直す",
      url: "https://yutaura.slack.com/archives/C0123ABCD/p1764000000123456",
      state: "open",
      fingerprint: "v1",
    });
    const tasks = yield* TaskRepository;
    const task = yield* tasks.createTask({ title: item.title, status: "todo" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    return task.id;
  });

const recording = (fail?: string) => {
  const calls: string[] = [];
  const accounts: string[] = [];
  const client = slackClientStub({
    completeSaved: (channel, ts) =>
      Effect.suspend(() => {
        calls.push(`complete ${channel} ${ts}`);
        return fail === undefined ? Effect.void : Effect.fail(new SlackRequestError({ message: fail }));
      }),
    removeSaved: (channel, ts) =>
      Effect.sync(() => {
        calls.push(`remove ${channel} ${ts}`);
      }),
  });
  const clientFor = (accountId: string) =>
    Effect.sync(() => {
      accounts.push(accountId);
      return client;
    });
  return { calls, accounts, clientFor };
};

const statusOf = (taskId: number) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status;
  });

describe("slackWrite（承認してから Slack に書き込む）", () => {
  it.effect("Slack の To-do を完了にし、承認を記録して、Task も完了にする", () =>
    Effect.gen(function* () {
      const taskId = yield* slackTask();
      const slack = recording();

      yield* slackWrite(taskId, "complete", slack.clientFor);

      assert.deepStrictEqual(slack.calls, ["complete C0123ABCD 1764000000.123456"]);
      assert.deepStrictEqual(slack.accounts, ["home"]);
      assert.strictEqual(yield* statusOf(taskId), "done");
      const [approval] = yield* (yield* Database).select().from(approvals).where(eq(approvals.taskId, taskId));
      assert.deepInclude(approval, { action: "slack_complete", target: "slack:home C0123ABCD:1764000000.123456", status: "executed" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("To-do・Saved から外したら、Task は片付ける", () =>
    Effect.gen(function* () {
      const taskId = yield* slackTask();
      const slack = recording();

      yield* slackWrite(taskId, "remove", slack.clientFor);

      assert.deepStrictEqual(slack.calls, ["remove C0123ABCD 1764000000.123456"]);
      assert.strictEqual(yield* statusOf(taskId), "dismissed");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("Slack に断られたら、承認を失敗として理由つきで残し、Task は動かさない", () =>
    Effect.gen(function* () {
      const taskId = yield* slackTask();

      const error = yield* slackWrite(taskId, "complete", recording("invalid_auth").clientFor).pipe(Effect.flip);

      assert.include(error.message, "invalid_auth");
      assert.strictEqual(yield* statusOf(taskId), "todo");
      const [approval] = yield* (yield* Database).select().from(approvals).where(eq(approvals.taskId, taskId));
      assert.strictEqual(approval?.status, "failed");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("Slack の To-do・Saved を追う Task でなければ、書き込まない", () =>
    Effect.gen(function* () {
      const taskId = yield* slackTask("github:personal");
      const slack = recording();

      const error = yield* slackWrite(taskId, "complete", slack.clientFor).pipe(Effect.flip);

      assert.include(error.message, "Slack");
      assert.lengthOf(slack.calls, 0);
    }).pipe(Effect.provide(TestDatabase)));
});
