import type { Meta, StoryObj } from "@storybook/react-vite";
import { framed } from "../frame.js";
import { routingItems } from "../fixtures.js";
import { Triage, TRIAGE_NOTES } from "./Triage.js";

const meta = {
  title: "ワイヤーフレーム/仕分け/画面",
  component: Triage,
  decorators: [framed],
  parameters: { wf: { notes: TRIAGE_NOTES } },
} satisfies Meta<typeof Triage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 振り分けを待っている事実: Story = {};

export const 判定できなかった: Story = { args: { select: { kind: "事実", id: 202 } } };

export const 要確認のTask: Story = { name: "要確認の Task", args: { select: { kind: "Task", id: 113 } } };

export const 候補のTaskがない: Story = { name: "候補の Task がない", args: { facts: routingItems.filter((item) => item.candidates.length === 0) } };

export const 仕分けるものはない: Story = { args: { facts: [], reviews: [] } };
