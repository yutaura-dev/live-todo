import { Schema } from "effect";
import { Decision } from "effect/ai";
import type { Answer } from "../../shared/answer.js";
import { TaskMaterial } from "../../shared/materials.js";
import type { Effort } from "../../shared/vocabulary.js";
import { topLabelAtLeast } from "../interpret.js";
import { defineQuestion } from "../question.js";

/** Action Item の手間（Generation が計画を書いたあと、Action Item ごとに判定する。文章が要らないので Decisions にする） */
export const itemEffortQuestion = defineQuestion({
  purpose: "plan.item-effort",
  version: 1,
  input: Schema.Struct({
    task: TaskMaterial,
    item: Schema.Struct({ title: Schema.String, /** 何によって果たされるか（人がやる・Claude Code が直す など）の要約 */ how: Schema.String }),
  }),
  decisions: () => ({
    effort: Decision.classify({
      instructions: "この Action Item（item）を、ユーザー本人がやるときの手間はどれくらいか。",
      criteria: {
        easy: "すぐ済む（数分〜数十分）",
        normal: "ふつう（半日ほど）",
        hard: "難しい（考える・調べる必要があり、数日かかる）",
        tedious: "面倒（難しくはないが手間がかかる。1〜2 日）",
      },
    }),
  }),
});

const EFFORT_THRESHOLD = 0.6;

/** 決まらなければ「判断できなかった」。すぐ済むと扱うと優先度を低く見積もるので、呼ぶ側が決める（ユーザーに見せる・重いほうに倒す） */
export function interpretEffort(answer: Answer<Decision.ClassifyAnswer<Effort>>): Effort | "判断できなかった" {
  return topLabelAtLeast(answer, EFFORT_THRESHOLD)?.label ?? "判断できなかった";
}
