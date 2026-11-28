import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        wfDesktop: { name: "ワイヤーフレーム PC 1440", styles: { width: "1440px", height: "900px" }, type: "desktop" },
        wfNarrow: { name: "ワイヤーフレーム PC 1280（狭い窓）", styles: { width: "1280px", height: "800px" }, type: "desktop" },
        uiNarrow: { name: "PC 1280（狭い窓）", styles: { width: "1280px", height: "800px" }, type: "desktop" },
      },
    },
    options: {
      storySort: {
        order: [
          "UI デザイン",
          ["はじめに", "見通し", "Task の詳細", "計画", "提案", "承認", "カンバン", "設定"],
          "ワイヤーフレーム",
          ["はじめに", ["読み方", "画面のつながり", "見通しの構造の案"], "見通し", "提案", "承認", "Task の詳細", "カンバン", "設定"],
        ],
      },
    },
  },
  // UI デザインの配色。窓に color-scheme を付けて、light-dark() に選ばせる（ワイヤーフレームには効かない）
  globalTypes: {
    scheme: {
      description: "配色",
      toolbar: {
        title: "配色",
        items: [
          { value: "light", title: "ライト" },
          { value: "dark", title: "ダーク" },
          { value: "system", title: "OS に合わせる" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { viewport: { value: "wfDesktop", isRotated: false }, scheme: "light" },
};

export default preview;
