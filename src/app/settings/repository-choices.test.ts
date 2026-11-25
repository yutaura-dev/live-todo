import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { repositoryChoicesFrom } from "./repository-choices.js";

describe("repositoryChoicesFrom", () => {
  it.effect("GitHub の一覧から、owner とリポジトリの候補を名前順に作る", () =>
    Effect.gen(function* () {
      const choices = yield* repositoryChoicesFrom([{ full_name: "acme/web" }, { full_name: "me/dotfiles" }, { full_name: "acme/app" }]);

      assert.deepStrictEqual(choices, { owners: ["acme", "me"], repositories: ["acme/app", "acme/web", "me/dotfiles"] });
    }));

  it.effect("大文字と小文字の違いだけの重複はまとめる（フィルタは大文字と小文字を区別しない）", () =>
    Effect.gen(function* () {
      const choices = yield* repositoryChoicesFrom([{ full_name: "Acme/App" }, { full_name: "acme/app" }]);

      assert.deepStrictEqual(choices, { owners: ["acme"], repositories: ["acme/app"] });
    }));

  it.effect("想定と違う形の応答はエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(repositoryChoicesFrom([{ name: "app" }]));

      assert.strictEqual(error._tag, "SchemaError");
    }));
});
