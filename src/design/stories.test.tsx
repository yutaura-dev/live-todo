// @vitest-environment happy-dom
import { assert, describe, it } from "@effect/vitest";
import { composeStories } from "@storybook/react-vite";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach } from "vitest";

// UI デザインは見た目の検討用で、振る舞いの正本は specs/、画面の構造の正本はワイヤーフレームにある。
// ここでは「どのストーリーも壊れずに描ける」「どのストーリーにも何の画面かを示す h1 が 1 つある」
// 「どのボタンにも名前がある」だけを守る
const modules = import.meta.glob<Record<string, unknown>>("./**/*.stories.tsx", { eager: true });

afterEach(cleanup);

describe("UI デザインのストーリー", () => {
  it("ストーリーがある", () => {
    assert.isAbove(Object.keys(modules).length, 0);
  });

  for (const [path, module] of Object.entries(modules)) {
    const stories = composeStories(module as Parameters<typeof composeStories>[0]);
    for (const [name, Story] of Object.entries(stories) as Array<[string, ComponentType]>) {
      it(`${path} の ${name} を描け、何の画面かを示す h1 が 1 つある`, () => {
        const view = render(<Story />);
        // モーダルのダイアログは自分の見出しを h1 に持つので、画面の h1 からは除く
        const headings = [...view.container.querySelectorAll("h1")].filter((heading) => heading.closest("dialog") === null);
        assert.strictEqual(headings.length, 1);
      });

      it(`${path} の ${name} のボタンには、すべて名前がある`, () => {
        const view = render(<Story />);
        const unnamed = [...view.container.querySelectorAll("button")].filter(
          (button) => (button.textContent ?? "").trim() === "" && !button.getAttribute("aria-label"),
        );
        assert.strictEqual(unnamed.length, 0);
      });
    }
  }
});
