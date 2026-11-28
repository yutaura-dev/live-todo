import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        wfDesktop: { name: "ワイヤーフレーム PC 1440", styles: { width: "1440px", height: "900px" }, type: "desktop" },
        wfNarrow: { name: "ワイヤーフレーム PC 1280（狭い窓）", styles: { width: "1280px", height: "800px" }, type: "desktop" },
      },
    },
    options: {
      storySort: {
        order: ["ワイヤーフレーム", ["はじめに", ["読み方", "画面のつながり", "見通しの構造の案"], "見通し", "仕分け", "承認", "Task の詳細", "カンバン", "設定"]],
      },
    },
  },
  initialGlobals: { viewport: { value: "wfDesktop", isRotated: false } },
};

export default preview;
