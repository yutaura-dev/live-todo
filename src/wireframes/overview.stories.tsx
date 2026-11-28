import type { Meta, StoryObj } from "@storybook/react-vite";
import { Legend, LEGEND_NOTES } from "./Legend.js";
import { Breadboard, HorizonDirections } from "./overview.js";
import { WfFrame } from "./frame.js";

const meta = {
  title: "ワイヤーフレーム/はじめに",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const 読み方: Story = {
  render: () => (
    <WfFrame notes={LEGEND_NOTES} height={720}>
      <Legend />
    </WfFrame>
  ),
};

/** 全画面の行き先を言葉で書き切ったもの。行き止まりや、どこからも来られない画面がないかを見る */
export const 画面のつながり: Story = {
  render: () => (
    <WfFrame height={900}>
      <Breadboard />
    </WfFrame>
  ),
};

/** 見通し（ホーム）の構造の 3 案。推奨は A */
export const 見通しの構造の案: Story = {
  render: () => (
    <WfFrame height={600}>
      <HorizonDirections />
    </WfFrame>
  ),
};
