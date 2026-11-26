import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../core/db/test-database.js";
import { MailClassifier } from "../core/judge/mail-classifier.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { GmailClient } from "../sources/gmail/gmail-client.js";
import { gmailSendersSource, gmailThreadsSource } from "../sources/gmail/gmail-bindings.js";
import { gmailMessage, makeTestGmail } from "../sources/gmail/test-client.js";
import { runGmailSync } from "./gmail-jobs.js";

describe("runGmailSync", () => {
  it.effect("メールを取り込んで仕分け、メルマガは送り主ごとの Task に、人からのメールはスレッドごとに保留にする", () => {
    const gmail = makeTestGmail([
      gmailMessage({ id: "news", headers: { from: "Shop <news@shop.example>", subject: "セール" } }),
      gmailMessage({ id: "person", threadId: "t1", headers: { from: "Sato <sato@example.com>", subject: "打ち合わせ" } }),
    ]);
    const classifier = MailClassifier.of({
      classify: (request) => Effect.succeed(request.input.includes("sato@") ? { kind: "personal", probability: 0.9, method: "decisions" } : { kind: "newsletter", probability: 0.9, method: "decisions" }),
      needsAction: () => Effect.succeed({ probability: 0.1, method: "decisions", topic: "other" }),
      matchesCondition: () => Effect.succeed({ probability: 0 }),
      interpretActions: () => Effect.die(new Error("使わない")),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 10, 26));
      yield* runGmailSync("me");

      const items = yield* SourceItemRepository;
      assert.strictEqual(Option.getOrThrow(yield* items.findItem(gmailSendersSource("me"), "news@shop.example#other")).triage, "linked");
      assert.strictEqual(Option.getOrThrow(yield* items.findItem(gmailThreadsSource("me"), "t1")).triage, "pending");
    }).pipe(Effect.provide(Layer.mergeAll(TestDatabase, Layer.succeed(GmailClient, gmail.client), Layer.succeed(MailClassifier, classifier))));
  });
});
