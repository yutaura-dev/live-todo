import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { withTransaction } from "../db/database.js";
import { TestDatabase } from "../db/test-database.js";
import { type SourceItemDraft, SourceItemRepository } from "./source-item-repository.js";

const draft = (overrides: Partial<SourceItemDraft> = {}): SourceItemDraft => ({
  source: "github",
  externalId: "pr-42",
  title: "Add retry to sync",
  url: "https://github.com/acme/app/pull/42",
  state: "open",
  fingerprint: "v1",
  ...overrides,
});

describe("SourceItemRepository", () => {
  it.effect("初めて保存した Item は triage が pending になり、source と externalId で取得できる", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
      const repo = yield* SourceItemRepository;

      const saved = yield* repo.upsertItem(draft());
      const found = yield* repo.findItem("github", "pr-42");

      assert.deepStrictEqual(found, Option.some(saved));
      assert.strictEqual(saved.triage, "pending");
      assert.strictEqual(saved.firstSeenAt, "2026-11-25T00:00:00.000Z");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("保存し直すと内容と状態が更新され、triage と初めて見た時刻は保たれる", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
      const repo = yield* SourceItemRepository;
      const first = yield* repo.upsertItem(draft());
      yield* repo.setTriage(first.id, "ignored");

      yield* TestClock.setTime(Date.parse("2026-11-25T01:00:00Z"));
      const second = yield* repo.upsertItem(draft({ state: "resolved", fingerprint: "v2" }));

      assert.strictEqual(second.id, first.id);
      assert.strictEqual(second.state, "resolved");
      assert.strictEqual(second.fingerprint, "v2");
      assert.strictEqual(second.triage, "ignored");
      assert.strictEqual(second.firstSeenAt, "2026-11-25T00:00:00.000Z");
      assert.strictEqual(second.updatedAt, "2026-11-25T01:00:00.000Z");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("記録した Activity を Item ごとに古い順で取得できる", () =>
    Effect.gen(function* () {
      const repo = yield* SourceItemRepository;
      const item = yield* repo.upsertItem(draft());

      yield* repo.recordActivity(item.id, "appeared");
      yield* repo.recordActivity(item.id, "changed");

      assert.deepStrictEqual(
        (yield* repo.listActivities(item.id)).map((activity) => activity.kind),
        ["appeared", "changed"],
      );
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("保存していない source のカーソルは none を返す", () =>
    Effect.gen(function* () {
      const repo = yield* SourceItemRepository;

      assert.isTrue(Option.isNone(yield* repo.loadCursor("github")));
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("保存したカーソルを読み出せ、保存し直すと上書きされる", () =>
    Effect.gen(function* () {
      const repo = yield* SourceItemRepository;

      yield* repo.saveCursor("github", { since: "2026-11-24T00:00:00Z" });
      yield* repo.saveCursor("github", { since: "2026-11-25T00:00:00Z" });

      assert.deepStrictEqual(yield* repo.loadCursor("github"), Option.some({ since: "2026-11-25T00:00:00Z" }));
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("トランザクションの中で失敗すると、それまでの書き込みを巻き戻す", () =>
    Effect.gen(function* () {
      const repo = yield* SourceItemRepository;

      yield* withTransaction(
        Effect.gen(function* () {
          yield* repo.upsertItem(draft());
          yield* repo.saveCursor("github", { since: "2026-11-25T00:00:00Z" });
          return yield* Effect.fail("boom");
        }),
      ).pipe(Effect.flip);

      assert.isTrue(Option.isNone(yield* repo.findItem("github", "pr-42")));
      assert.isTrue(Option.isNone(yield* repo.loadCursor("github")));
    }).pipe(Effect.provide(TestDatabase)));
});
