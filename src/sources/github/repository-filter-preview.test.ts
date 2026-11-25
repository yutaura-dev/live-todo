import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { explainRepositoryFilter, parseGitHubTarget, previewRepositoryFilter } from "./repository-filter-preview.js";

describe("parseGitHubTarget", () => {
  it.each([
    ["https://github.com/acme/app/pull/42", { repository: "acme/app", kind: "pull", number: 42 }],
    ["https://github.com/acme/app/pull/42/files", { repository: "acme/app", kind: "pull", number: 42 }],
    ["https://github.com/acme/app/issues/7#issuecomment-1", { repository: "acme/app", kind: "issue", number: 7 }],
    ["https://github.com/acme/app", { repository: "acme/app", kind: "repository" }],
    ["acme/app", { repository: "acme/app", kind: "repository" }],
    ["acme/app#12", { repository: "acme/app", kind: "number", number: 12 }],
    ["  acme/app  ", { repository: "acme/app", kind: "repository" }],
  ] as const)("%s を読み取る", (input, expected) => {
    assert.deepStrictEqual(parseGitHubTarget(input), expected);
  });

  it.each(["https://gitlab.com/acme/app", "acme", "https://github.com/acme", "not a url", ""])(
    "GitHub のリポジトリ・PR・issue を指していなければ undefined を返す: %s",
    (input) => {
      assert.isUndefined(parseGitHubTarget(input));
    },
  );
});

describe("explainRepositoryFilter", () => {
  it.effect("フィルタがなければ、すべて含めることを理由にする", () =>
    Effect.gen(function* () {
      const explain = yield* explainRepositoryFilter({});
      assert.deepStrictEqual(explain("acme/app"), { included: true, reason: { kind: "no_filter" } });
    }));

  it.effect("include に一致したら、一致したパターンを返す", () =>
    Effect.gen(function* () {
      const explain = yield* explainRepositoryFilter({ include: ["acme/*"] });
      assert.deepStrictEqual(explain("Acme/App"), { included: true, reason: { kind: "included_by", pattern: "acme/*" } });
    }));

  it.effect("include があって一致しなければ、どれにも一致しないことを理由に除く", () =>
    Effect.gen(function* () {
      const explain = yield* explainRepositoryFilter({ include: ["acme/*"] });
      assert.deepStrictEqual(explain("other/app"), { included: false, reason: { kind: "not_in_include" } });
    }));

  it.effect("exclude に一致したら、include に一致しても除き、exclude のパターンを返す", () =>
    Effect.gen(function* () {
      const explain = yield* explainRepositoryFilter({ include: ["acme/*"], exclude: ["acme/legacy"] });
      assert.deepStrictEqual(explain("acme/legacy"), { included: false, reason: { kind: "excluded_by", pattern: "acme/legacy" } });
    }));

  it.effect("exclude だけなら、exclude 以外は exclude に一致しないことを理由に含める", () =>
    Effect.gen(function* () {
      const explain = yield* explainRepositoryFilter({ exclude: ["acme/legacy"] });
      assert.deepStrictEqual(explain("acme/app"), { included: true, reason: { kind: "not_excluded" } });
    }));

  it.effect("形の正しくないパターンはエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(explainRepositoryFilter({ include: ["acme"] }));
      assert.strictEqual(error._tag, "InvalidRepositoryPatternError");
    }));
});

describe("previewRepositoryFilter", () => {
  it.effect("候補のリポジトリを、含めるものと除くものに分け、重複をまとめて名前順に並べる", () =>
    Effect.gen(function* () {
      const preview = yield* previewRepositoryFilter({ include: ["acme/*"], exclude: ["acme/legacy"] }, [
        "acme/web",
        "other/tool",
        "acme/legacy",
        "acme/app",
        "Acme/App",
      ]);
      assert.deepStrictEqual(
        preview.included.map((entry) => entry.repository),
        ["acme/app", "acme/web"],
      );
      assert.deepStrictEqual(preview.excluded, [
        { repository: "acme/legacy", included: false, reason: { kind: "excluded_by", pattern: "acme/legacy" } },
        { repository: "other/tool", included: false, reason: { kind: "not_in_include" } },
      ]);
    }));

  it.effect("使われていないパターンを返す（打ち間違いに気づけるように）", () =>
    Effect.gen(function* () {
      const preview = yield* previewRepositoryFilter({ include: ["acme/*", "acem/*"], exclude: ["acme/old"] }, ["acme/app"]);
      assert.deepStrictEqual(preview.unusedPatterns, ["acem/*", "acme/old"]);
    }));
});
