// @vitest-environment happy-dom
import { assert, describe, it } from "@effect/vitest";
import { composeStories } from "@storybook/react-vite";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach } from "vitest";

// ワイヤーフレームは画面の検討用で、振る舞いの正本は specs/ にある。
// ここでは「どのストーリーも壊れずに描ける」「どのストーリーにも何の画面かを示す h1 が 1 つある」だけを守る
const modules = import.meta.glob<Record<string, unknown>>("./**/*.stories.tsx", { eager: true });

afterEach(cleanup);

describe("ワイヤーフレームのストーリー", () => {
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

      it(`${path} の ${name} の注釈マーカーには、すべて対応する説明がある`, () => {
        const view = render(<Story />);
        const marks = [...view.container.querySelectorAll("[data-wf-mark]")].map((mark) => mark.getAttribute("data-wf-mark"));
        const notes = new Set([...view.container.querySelectorAll("[data-wf-note]")].map((note) => note.getAttribute("data-wf-note")));
        assert.deepStrictEqual(
          marks.filter((mark) => !notes.has(mark)),
          [],
        );
      });
    }
  }
});
