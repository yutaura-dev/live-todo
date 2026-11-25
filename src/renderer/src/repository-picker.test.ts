import { assert, describe, it } from "@effect/vitest";
import { suggestPatterns } from "./repository-picker.js";

const choices = { owners: ["acme", "me"], repositories: ["acme/app", "acme/web", "me/dotfiles"] };

describe("suggestPatterns", () => {
  it("入力がなければ、owner のまとめ（owner/*）を先に、そのあとリポジトリを並べる", () => {
    assert.deepStrictEqual(suggestPatterns(choices, "", []), ["acme/*", "me/*", "acme/app", "acme/web", "me/dotfiles"]);
  });

  it("入力を含むものに絞る（大文字と小文字を区別しない）", () => {
    assert.deepStrictEqual(suggestPatterns(choices, "WEB", []), ["acme/web"]);
    assert.deepStrictEqual(suggestPatterns(choices, "acme", []), ["acme/*", "acme/app", "acme/web"]);
  });

  it("選んだものは候補から外す", () => {
    assert.deepStrictEqual(suggestPatterns(choices, "acme", ["acme/*", "acme/web"]), ["acme/app"]);
  });

  it("一覧にない owner/repo の形の入力は、そのまま追加できる候補として先頭に出す", () => {
    assert.deepStrictEqual(suggestPatterns(choices, "other/tool", []), ["other/tool"]);
    assert.deepStrictEqual(suggestPatterns(choices, "other/*", []), ["other/*"]);
  });

  it("owner/repo の形でない入力は、一覧に一致しなければ候補を出さない", () => {
    assert.deepStrictEqual(suggestPatterns(choices, "zzz", []), []);
  });

  it("候補は多すぎないよう上限で切る", () => {
    const many = { owners: [], repositories: Array.from({ length: 100 }, (_, index) => `acme/repo-${String(index).padStart(3, "0")}`) };
    assert.strictEqual(suggestPatterns(many, "", []).length, 50);
  });
});
