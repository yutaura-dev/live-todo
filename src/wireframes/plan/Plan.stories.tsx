import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { framed } from "../frame.js";
import type { PlanGroup } from "./plan.js";
import { blockedPlan, checkPlan, chosenPlan, decisionPlan, nestedParallelPlan, parallelPlan, planLaterPlan, rechosenPlan, straightPlan, troublePlan } from "./plan-fixtures.js";
import { Plan, PLAN_NOTES } from "./PlanView.js";

/** 計画だけを、詳細の中と同じ幅で状態ごとに見比べる。「済んだ」「これにする」「選び直す」「戻す」は押すと進む */
function Playground({ initial }: { initial: PlanGroup }) {
  const [plan, setPlan] = useState(initial);
  return (
    <div className="wf-inspector" style={{ blockSize: "100%", display: "grid", gap: 16, alignContent: "start" }}>
      <h1 className="wf-section-title">計画（Task の詳細の中）</h1>
      <Plan plan={plan} onChange={setPlan} annotate />
    </div>
  );
}

const meta = {
  title: "ワイヤーフレーム/Task の詳細/計画",
  component: Playground,
  decorators: [framed],
  parameters: { wf: { notes: PLAN_NOTES, width: 480, height: 900 } },
} satisfies Meta<typeof Playground>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 一本道: Story = { args: { initial: straightPlan } };

export const 番待ちが続く: Story = { args: { initial: blockedPlan } };

export const 同時に進められる: Story = { args: { initial: parallelPlan } };

/** 並列の中に、直列の枝と分かれ道の枝がある。枝ごとに進み具合が違う */
export const 並列の中に枝と分かれ道: Story = { args: { initial: nestedParallelPlan } };

/** 事実を確かめれば答えが決まる分かれ道。得るもの・失うもの・おすすめは出さず、確かめ方を出す */
export const 確かめる分かれ道: Story = { args: { initial: checkPlan } };

/** 天秤にかけて決める分かれ道。おすすめ・比べること・選択肢ごとの得るもの・失うものを出す */
export const 分かれ道を選ぶ前: Story = { args: { initial: decisionPlan } };

export const 分かれ道を選んだあと: Story = { args: { initial: chosenPlan } };

export const 選び直した: Story = { args: { initial: rechosenPlan } };

export const AIが先を考えている: Story = { name: "AI が先を考えている", args: { initial: planLaterPlan } };

export const うまくいかなかった: Story = { args: { initial: troublePlan } };
