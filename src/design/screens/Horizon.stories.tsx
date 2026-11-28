import type { Meta, StoryObj } from "@storybook/react-vite";
import { tasks } from "../../wireframes/fixtures.js";
import { windowed } from "../frame.js";
import { Horizon } from "./Horizon.js";
import { Prototype } from "./Prototype.js";

const meta = {
  title: "UI デザイン/見通し",
  component: Horizon,
  decorators: [windowed],
} satisfies Meta<typeof Horizon>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 毎朝ひらいたときの画面 */
export const 朝いちばん: Story = {};

/** Task を押すと、一覧の右に詳細が並ぶ（一覧は操作できるまま） */
export const 詳細を開いた: Story = { args: { openTaskId: 103 } };

export const AIが作業中のTaskを開いた: Story = { name: "AI が作業中の Task を開いた", args: { openTaskId: 105 } };

export const 番待ちが続くTaskを開いた: Story = { name: "番待ちが続く Task を開いた", args: { openTaskId: 106 } };

export const 分かれ道のあるTaskを開いた: Story = { name: "分かれ道のある Task を開いた", args: { openTaskId: 108 } };

export const ラベル未定を開いた: Story = { args: { openTaskId: 109 } };

/** 今すぐ・今日中が空でも見出しは残す */
export const 今日やることはない: Story = {
  args: {
    tasks: tasks.filter((task) => task.priority?.status === "アプリが決めた" && ["10 日以内", "30 日以内", "それより先でよい"].includes(task.priority.level)),
  },
};

export const 取り込めていない: Story = {
  args: { sync: { state: "problem", text: "会社の Slack を 7:30 から取り込めていません（セッションが切れた）" } },
};

export const 大量に消えた: Story = { args: { massRemoval: { account: "会社の Gmail", stream: "受信箱", count: 42 } } };

/** 狭いノート PC の窓（1280×800）。詳細を並べても一覧の次の一手が読めるか */
export const 狭い窓で詳細を開いた: Story = {
  args: { openTaskId: 103 },
  globals: { viewport: { value: "uiNarrow", isRotated: false } },
};

/** 全画面をつないで、左のレールで行き来できるようにしたもの */
export const 通しで触る: Story = { render: () => <Prototype /> };
