// @vitest-environment happy-dom
import { assert, describe, it } from "@effect/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import githubDark from "./assets/brands/github-dark.svg";
import github from "./assets/brands/github.svg";
import notionDark from "./assets/brands/notion-dark.svg";
import notion from "./assets/brands/notion.svg";
import { SourceMarks } from "./components.js";
import { SchemeProvider } from "./scheme.js";
import { BrandIconsProvider } from "./source-icons.js";

afterEach(cleanup);

const itemsOf = (container: HTMLElement) => [...container.querySelectorAll('[role="listitem"]')];
const srcOf = (item: Element | undefined) => item?.querySelector("img")?.getAttribute("src") ?? "";

describe("取得元の印", () => {
  it("公式のアイコンを置いてあるサービスは、そのアイコンの画像で見せる", () => {
    const view = render(<SourceMarks sources={["github", "gmail", "calendar", "notion", "outlook", "teams"]} />);
    for (const item of itemsOf(view.container)) {
      assert.isNotNull(item.querySelector("img"));
      assert.strictEqual((item.textContent ?? "").trim(), "");
    }
  });

  it("アイコンには、読み上げ用にサービスの名前を付ける", () => {
    const view = render(<SourceMarks sources={["github", "slack", "manual"]} />);
    const names = itemsOf(view.container).map((item) => item.getAttribute("aria-label"));
    assert.deepStrictEqual(names, ["GitHub", "Slack", "手で追加"]);
  });

  it("アイコンを置いていないサービスは、名前の文字で見せる", () => {
    const view = render(
      <BrandIconsProvider icons={{}}>
        <SourceMarks sources={["slack"]} />
      </BrandIconsProvider>,
    );
    const item = itemsOf(view.container)[0];
    assert.strictEqual(item?.textContent, "Slack");
    assert.isNull(item?.querySelector("img") ?? null);
  });

  it("アイコンを置いたサービスは、そのアイコンで見せる", () => {
    const view = render(
      <BrandIconsProvider icons={{ slack: { light: "/slack.svg", dark: "/slack-dark.svg" } }}>
        <SourceMarks sources={["slack"]} />
      </BrandIconsProvider>,
    );
    assert.strictEqual(srcOf(itemsOf(view.container)[0]), "/slack.svg");
  });

  it("手で追加した Task は、鉛筆の印で見せる", () => {
    const view = render(<SourceMarks sources={["manual"]} />);
    assert.isNotNull(itemsOf(view.container)[0]?.querySelector("svg") ?? null);
  });

  it("知らない取得元は、取得元の名前をそのまま文字で見せる", () => {
    const view = render(<SourceMarks sources={["jira"]} />);
    assert.strictEqual(itemsOf(view.container)[0]?.textContent, "jira");
  });

  it("ダークの配色では、GitHub と Notion を白の公式アイコンに切り替える", () => {
    const light = render(<SourceMarks sources={["github", "notion"]} />);
    const lightSources = itemsOf(light.container).map(srcOf);
    cleanup();
    const dark = render(
      <SchemeProvider scheme="dark">
        <SourceMarks sources={["github", "notion"]} />
      </SchemeProvider>,
    );
    assert.deepStrictEqual(lightSources, [github, notion]);
    assert.deepStrictEqual(itemsOf(dark.container).map(srcOf), [githubDark, notionDark]);
  });
});
