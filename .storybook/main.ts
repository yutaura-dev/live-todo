import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  // ワイヤーフレームと UI デザインだけを載せる。実装の画面（src/renderer）は preload の API に依存していて、そのままでは描けないため
  stories: ["../src/wireframes/**/*.stories.tsx", "../src/design/**/*.stories.tsx"],
  framework: { name: "@storybook/react-vite", options: {} },
};

export default config;
