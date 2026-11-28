import { assert, describe, it } from "@effect/vitest";
import { brandIconsFrom } from "./brand-icons.js";

describe("サービスのアイコンのファイル", () => {
  it("ファイル名が取得元の名前なら、その取得元のアイコンにする", () => {
    const icons = brandIconsFrom({ "./assets/brands/slack.svg": "/slack.svg" });
    assert.deepStrictEqual(icons, { slack: { light: "/slack.svg", dark: "/slack.svg" } });
  });

  it("名前に -dark が付いたファイルがあれば、ダークの配色ではそちらを使う", () => {
    const icons = brandIconsFrom({ "./assets/brands/github.svg": "/github.svg", "./assets/brands/github-dark.svg": "/github-dark.svg" });
    assert.deepStrictEqual(icons, { github: { light: "/github.svg", dark: "/github-dark.svg" } });
  });

  it("-dark のファイルしかなければ、ライトの配色でもそれを使う", () => {
    const icons = brandIconsFrom({ "./assets/brands/outlook-dark.svg": "/outlook-dark.svg" });
    assert.deepStrictEqual(icons, { outlook: { light: "/outlook-dark.svg", dark: "/outlook-dark.svg" } });
  });

  it("何も置いていなければ、アイコンはない", () => {
    assert.deepStrictEqual(brandIconsFrom({}), {});
  });
});
