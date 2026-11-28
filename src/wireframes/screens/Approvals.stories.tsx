import type { Meta, StoryObj } from "@storybook/react-vite";
import { framed } from "../frame.js";
import { Approvals, APPROVAL_NOTES, APPROVAL_QUESTIONS } from "./Approvals.js";

const meta = {
  title: "ワイヤーフレーム/承認/画面",
  component: Approvals,
  decorators: [framed],
  parameters: { wf: { notes: APPROVAL_NOTES, questions: APPROVAL_QUESTIONS } },
} satisfies Meta<typeof Approvals>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Mergeを確かめる: Story = { name: "merge を確かめる" };

export const 返信を確かめる: Story = { args: { select: { kind: "頼む", id: 302 } } };

export const 版が変わった: Story = { args: { freshness: "版が変わった" } };

export const 書き込めない状態: Story = { args: { freshness: "書き込めない状態" } };

export const 書き込めなかった: Story = { args: { select: { kind: "困った", id: 303 } } };

export const 書けたか分からない: Story = { args: { select: { kind: "困った", id: 304 } } };

export const 待っているものはない: Story = { args: { requests: [], troubles: [] } };
