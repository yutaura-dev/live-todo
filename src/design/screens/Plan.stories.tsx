import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { PlanGroup } from "../../wireframes/plan/plan.js";
import { blockedPlan, checkPlan, chosenPlan, decisionPlan, nestedParallelPlan, parallelPlan, planLaterPlan, rechosenPlan, straightPlan, troublePlan } from "../../wireframes/plan/plan-fixtures.js";
import { windowedPanel } from "../frame.js";
import { Plan } from "./Plan.js";

/** 計画だけを、詳細の中と同じ幅で状態ごとに見比べる。「済んだ」「これにする」「選び直す」「戻す」は押すと進む */
function Playground({ initial }: { initial: PlanGroup }) {
  const [plan, setPlan] = useState(initial);
  return (
    <div className="ui-detail">
      <h1 className="ui-section-title">計画</h1>
      <Plan plan={plan} onChange={setPlan} />
    </div>
  );
}

const meta = {
  title: "UI デザイン/計画",
  component: Playground,
  decorators: [windowedPanel],
} satisfies Meta<typeof Playground>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 一本道: Story = { args: { initial: straightPlan } };

export const 番待ちが続く: Story = { args: { initial: blockedPlan } };

export const 同時に進められる: Story = { args: { initial: parallelPlan } };

export const 並列の中に枝と分かれ道: Story = { args: { initial: nestedParallelPlan } };

export const 確かめる分かれ道: Story = { args: { initial: checkPlan } };

export const 分かれ道を選ぶ前: Story = { args: { initial: decisionPlan } };

export const 分かれ道を選んだあと: Story = { args: { initial: chosenPlan } };

export const 選び直した: Story = { args: { initial: rechosenPlan } };

export const AIが先を考えている: Story = { name: "AI が先を考えている", args: { initial: planLaterPlan } };

export const うまくいかなかった: Story = { args: { initial: troublePlan } };
