import type { Meta, StoryObj } from "@storybook/react-vite";
import { proposals } from "../../wireframes/fixtures.js";
import { windowed } from "../frame.js";
import { Proposals } from "./Proposals.js";

const meta = {
  title: "UI デザイン/提案",
  component: Proposals,
  decorators: [windowed],
} satisfies Meta<typeof Proposals>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 既存の Task に足す提案（寄せ先つき） */
export const 計画に足す提案: Story = {};

export const 新しいTaskの提案: Story = { name: "新しい Task の提案", args: { select: { kind: "提案", id: 402 } } };

/** 同じ件の事実が続けて届いて、1 つの提案にまとまったもの */
export const 事実がまとまった提案: Story = { args: { select: { kind: "提案", id: 403 } } };

/** 完了条件を満たしたのに、事実から足した項目が残っていて、自動で閉じるのを止めたもの */
export const 切り出す提案: Story = { args: { select: { kind: "提案", id: 404 } } };

export const AIが判断できなかった事実: Story = { name: "AI が判断できなかった事実", args: { select: { kind: "事実", id: 202 } } };

export const 決めるものはない: Story = { args: { proposals: proposals.filter((item) => item.status === "見送った"), facts: [] } };
