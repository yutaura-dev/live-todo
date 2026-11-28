import type { Meta, StoryObj } from "@storybook/react-vite";
import { Board } from "./Board.js";
import { windowed } from "../frame.js";

const meta = {
  title: "UI デザイン/カンバン",
  component: Board,
  decorators: [windowed],
} satisfies Meta<typeof Board>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ふだん: Story = {};
