import type { Meta, StoryObj } from "@storybook/react-vite";
import { awaitingDetail, awaitingFailedDetail, decisionDetail, mergeDetail, undecidedDetail, waitingDetail, workingDetail } from "../../wireframes/detail-fixtures.js";
import { windowedPanel } from "../frame.js";
import { TaskDetail } from "./TaskDetail.js";

/** 見通しの右に並ぶ詳細を、同じ幅（480）で単独に見る */
const meta = {
  title: "UI デザイン/Task の詳細",
  component: TaskDetail,
  args: { headingLevel: 1 },
  decorators: [windowedPanel],
} satisfies Meta<typeof TaskDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 次の一手が書き込み: Story = { args: { data: mergeDetail } };

export const 分かれ道: Story = { args: { data: decisionDetail } };

export const AIが作業中: Story = { name: "AI が作業中", args: { data: workingDetail } };

export const 番待ちと定期の提案: Story = { args: { data: waitingDetail } };

export const ラベル未定: Story = { args: { data: undecidedDetail } };

export const 完了待ち: Story = { args: { data: awaitingDetail } };

export const 完了待ちで書き込めなかった: Story = { args: { data: awaitingFailedDetail } };
