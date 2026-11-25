import { assert, describe, it } from "@effect/vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown.js";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text, onOpenLink: () => {} }));

describe("Markdown", () => {
  it("見出し・箇条書き・コードを、それぞれの要素として表示する", () => {
    const html = render("## 結論\n\n- `a.ts` を直す\n- 表示を確かめる");

    assert.include(html, "<h2>結論</h2>");
    assert.include(html, "<li><code>a.ts</code> を直す</li>");
  });

  it("表（GitHub の Markdown）も表示する", () => {
    assert.include(render("| a | b |\n|---|---|\n| 1 | 2 |"), "<table>");
  });

  it("文字列中の HTML は要素にしない（PR の本文などに仕込まれた script を動かさない）", () => {
    const html = render("<script>alert(1)</script><b>太字</b>");

    assert.notInclude(html, "<script>");
    assert.notInclude(html, "<b>");
  });

  it("画像は読み込まず、代わりの文字だけを出す（開いたことを外部に知られないため）", () => {
    const html = render("![図](https://evil.example/track.png)");

    assert.notInclude(html, "<img");
    assert.notInclude(html, "evil.example");
    assert.include(html, "図");
  });

  it("javascript: のリンクはリンクとして効かない", () => {
    assert.notInclude(render("[押して](javascript:alert(1))"), "javascript:");
  });
});
