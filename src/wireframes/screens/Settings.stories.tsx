import type { Meta, StoryObj } from "@storybook/react-vite";
import { framed } from "../frame.js";
import { Settings, SETTINGS_NOTES, SETUP_ROLES, SUSPENDED_ROLES } from "./Settings.js";

const meta = {
  title: "ワイヤーフレーム/設定/画面",
  component: Settings,
  decorators: [framed],
  parameters: { wf: { notes: SETTINGS_NOTES } },
} satisfies Meta<typeof Settings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ふだん: Story = {};

/** 3 つそろうまでは、設定の画面だけ出す */
export const 初めての起動: Story = { args: { roles: SETUP_ROLES } };

/** どれかの認証が通らないと、直すまでアプリ全体を止める */
export const AIの認証が通らない: Story = { name: "AI の認証が通らない", args: { roles: SUSPENDED_ROLES } };
