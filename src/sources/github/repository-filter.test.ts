import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { InvalidRepositoryPatternError, makeRepositoryFilter } from "./repository-filter.js";

describe("makeRepositoryFilter", () => {
  it.effect("include も exclude も指定しなければすべてのリポジトリを対象にする", () =>
    Effect.gen(function* () {
      const matches = yield* makeRepositoryFilter({});

      assert.isTrue(matches("acme/app"));
    }));

  it.effect("include に owner/* を指定すると、その owner のリポジトリだけを対象にする", () =>
    Effect.gen(function* () {
      const matches = yield* makeRepositoryFilter({ include: ["acme/*"] });

      assert.isTrue(matches("acme/app"));
      assert.isFalse(matches("other/app"));
    }));

  it.effect("include に owner/repo を指定すると、そのリポジトリだけを対象にする", () =>
    Effect.gen(function* () {
      const matches = yield* makeRepositoryFilter({ include: ["acme/app"] });

      assert.isTrue(matches("acme/app"));
      assert.isFalse(matches("acme/web"));
    }));

  it.effect("exclude に一致するリポジトリは include に一致しても対象外にする", () =>
    Effect.gen(function* () {
      const matches = yield* makeRepositoryFilter({ include: ["acme/*"], exclude: ["acme/legacy"] });

      assert.isTrue(matches("acme/app"));
      assert.isFalse(matches("acme/legacy"));
    }));

  it.effect("include を指定せず exclude だけ指定すると、exclude 以外をすべて対象にする", () =>
    Effect.gen(function* () {
      const matches = yield* makeRepositoryFilter({ exclude: ["personal/*"] });

      assert.isTrue(matches("acme/app"));
      assert.isFalse(matches("personal/dotfiles"));
    }));

  it.effect("大文字と小文字を区別しない", () =>
    Effect.gen(function* () {
      const matches = yield* makeRepositoryFilter({ include: ["Acme/*"] });

      assert.isTrue(matches("acme/App"));
    }));

  it.effect("owner/* の owner が一致するだけで、名前の前方一致では対象にしない", () =>
    Effect.gen(function* () {
      const matches = yield* makeRepositoryFilter({ include: ["acme/*"] });

      assert.isFalse(matches("acme-labs/app"));
    }));

  it.effect.each(["acme", "*/*", "acme/app/extra", "", "acme/"])("不正なパターン %j はエラーにする", (pattern) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeRepositoryFilter({ include: [pattern] }));

      assert.instanceOf(error, InvalidRepositoryPatternError);
      assert.strictEqual(error.pattern, pattern);
    }));
});
