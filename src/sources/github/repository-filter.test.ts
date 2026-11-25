import { describe, expect, it } from "vitest";
import { createRepositoryFilter } from "./repository-filter.js";

describe("createRepositoryFilter", () => {
  it("include も exclude も指定しなければすべてのリポジトリを対象にする", () => {
    const matches = createRepositoryFilter({});

    expect(matches("acme/app")).toBe(true);
  });

  it("include に owner/* を指定すると、その owner のリポジトリだけを対象にする", () => {
    const matches = createRepositoryFilter({ include: ["acme/*"] });

    expect(matches("acme/app")).toBe(true);
    expect(matches("other/app")).toBe(false);
  });

  it("include に owner/repo を指定すると、そのリポジトリだけを対象にする", () => {
    const matches = createRepositoryFilter({ include: ["acme/app"] });

    expect(matches("acme/app")).toBe(true);
    expect(matches("acme/web")).toBe(false);
  });

  it("exclude に一致するリポジトリは include に一致しても対象外にする", () => {
    const matches = createRepositoryFilter({ include: ["acme/*"], exclude: ["acme/legacy"] });

    expect(matches("acme/app")).toBe(true);
    expect(matches("acme/legacy")).toBe(false);
  });

  it("include を指定せず exclude だけ指定すると、exclude 以外をすべて対象にする", () => {
    const matches = createRepositoryFilter({ exclude: ["personal/*"] });

    expect(matches("acme/app")).toBe(true);
    expect(matches("personal/dotfiles")).toBe(false);
  });

  it("大文字と小文字を区別しない", () => {
    const matches = createRepositoryFilter({ include: ["Acme/*"] });

    expect(matches("acme/App")).toBe(true);
  });

  it("owner/* の owner が一致するだけで、名前の前方一致では対象にしない", () => {
    const matches = createRepositoryFilter({ include: ["acme/*"] });

    expect(matches("acme-labs/app")).toBe(false);
  });

  it.each(["acme", "*/*", "acme/app/extra", "", "acme/"])("不正なパターン %j はエラーにする", (pattern) => {
    expect(() => createRepositoryFilter({ include: [pattern] })).toThrow(`不正なリポジトリのパターンです: ${pattern}`);
  });
});
