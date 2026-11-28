import type { Meta, StoryObj } from "@storybook/react-vite";
import { framed } from "../frame.js";
import { Board, BOARD_NOTES, BOARD_QUESTIONS } from "./Board.js";

const meta = {
  title: "ワイヤーフレーム/カンバン/画面",
  component: Board,
  decorators: [framed],
  parameters: { wf: { notes: BOARD_NOTES, questions: BOARD_QUESTIONS } },
} satisfies Meta<typeof Board>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ふだん: Story = {};
