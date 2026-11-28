import type { Meta, StoryObj } from "@storybook/react-vite";
import { awaitingDetail, awaitingFailedDetail, decisionDetail, mergeDetail, undecidedDetail, waitingDetail, workingDetail } from "../detail-fixtures.js";
import { framed } from "../frame.js";
import { DETAIL_NOTES, TaskDetail } from "./TaskDetail.js";

/** 見通しの右に並ぶ詳細（幅 480）を単独で見る */
const meta = {
  title: "ワイヤーフレーム/Task の詳細/画面",
  component: TaskDetail,
  args: { headingLevel: 1, annotate: true },
  decorators: [
    (Story) => (
      <div className="wf-inspector" style={{ blockSize: "100%" }}>
        <Story />
      </div>
    ),
    framed,
  ],
  parameters: { wf: { notes: DETAIL_NOTES, width: 480, height: 900 } },
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
