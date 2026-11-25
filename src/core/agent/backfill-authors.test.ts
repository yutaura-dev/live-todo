import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestDatabase } from "../db/test-database.js";
import { SourceItemRepository } from "../source/source-item-repository.js";
import { backfillAuthorsFromJudgments } from "./backfill-authors.js";

const item = (externalId: string, judgment?: unknown, author?: string) =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const stored = yield* items.upsertItem({
      source: "github:personal",
      externalId,
      title: externalId,
      url: `https://github.com/acme/app/pull/${externalId}`,
      state: "open",
      fingerprint: "v1",
      ...(author === undefined ? {} : { author }),
    });
    if (judgment !== undefined) yield* items.setTriage(stored.id, "linked", judgment);
  });

const authorOf = (externalId: string) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* SourceItemRepository).findItem("github:personal", externalId)).author;
  });

describe("backfillAuthorsFromJudgments", () => {
  it.effect("作成者が空の項目に、判定のときに LLM に渡した入力から作成者を埋める", () =>
    Effect.gen(function* () {
      yield* item("1", { verdict: "todo", method: "rule", request: { input: "タイトル: Update\n作成者: @renovate[bot]\n本文: ..." } });

      assert.strictEqual(yield* backfillAuthorsFromJudgments, 1);
      assert.strictEqual(yield* authorOf("1"), "renovate[bot]");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("作成者が入っている項目と、判定の記録に作成者がない項目は変えない", () =>
    Effect.gen(function* () {
      yield* item("1", { request: { input: "作成者: @renovate[bot]" } }, "octocat");
      yield* item("2", { request: { input: "タイトルだけ" } });
      yield* item("3");

      assert.strictEqual(yield* backfillAuthorsFromJudgments, 0);
      assert.strictEqual(yield* authorOf("1"), "octocat");
      assert.isNull(yield* authorOf("2"));
    }).pipe(Effect.provide(TestDatabase)));
});
