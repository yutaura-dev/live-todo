import { Schema } from "effect";
import { type Answer, unanswered } from "../../shared/answer.js";
import { TaskMaterial } from "../../shared/materials.js";
import { Aspect } from "../../shared/vocabulary.js";
import { defineWriting } from "../writing.js";

const OptionWithAspects = Schema.Struct({ label: Schema.String, then: Schema.String, gains: Schema.Array(Aspect), costs: Schema.Array(Aspect) });
const Point = Schema.Struct({ aspect: Aspect, detail: Schema.String });

const PointDetailsInput = Schema.Struct({ task: TaskMaterial, question: Schema.String, options: Schema.Array(OptionWithAspects) });
const PointDetailsOutput = Schema.Struct({ options: Schema.Array(Schema.Struct({ label: Schema.String, gains: Schema.Array(Point), costs: Schema.Array(Point) })) });

/** 得るもの・失うものの具体的な中身。どの観点かは Decisions が決めたもので、Generation は中身だけを書く */
export const pointDetailsWriting = defineWriting({
  purpose: "decision-point.point-details",
  version: 1,
  objectName: "point_details",
  input: PointDetailsInput,
  output: PointDetailsOutput,
  instructions: () =>
    [
      "分かれ道（question）の選択肢ごとに、得るもの（gains）と失うもの（costs）の観点が決まっています。",
      "観点ごとに、具体的にどうなるか（「鍵が漏れても 1 時間で無効にできる」「数十分の作業が要る」など）を 1 文で書いてください。",
      "観点を足したり、落としたりしないでください。",
    ].join("\n"),
});

/** Generation が、Decisions の決めた観点のとおりに書いたか。足した・落とした観点があれば形に合わないにする（判定を書き換えさせない） */
export function checkPointDetails(
  input: { readonly options: ReadonlyArray<{ readonly label: string; readonly gains: ReadonlyArray<Aspect>; readonly costs: ReadonlyArray<Aspect> }> },
  answer: Answer<typeof PointDetailsOutput.Type>,
): Answer<typeof PointDetailsOutput.Type> {
  if (answer._tag === "Unanswered") return answer;
  const same = (want: ReadonlyArray<Aspect>, got: ReadonlyArray<{ readonly aspect: Aspect }>) =>
    want.length === got.length && want.every((aspect) => got.some((point) => point.aspect === aspect));
  const matches =
    answer.value.options.length === input.options.length &&
    input.options.every((option, i) => {
      const written = answer.value.options[i];
      return written !== undefined && written.label === option.label && same(option.gains, written.gains) && same(option.costs, written.costs);
    });
  return matches ? answer : unanswered("Invalid");
}

/** おすすめの理由（おすすめの選択肢は Decisions が選ぶ。Generation は得るもの・失うものを踏まえて理由を書く） */
export const recommendationReasonWriting = defineWriting({
  purpose: "decision-point.recommendation-reason",
  version: 1,
  objectName: "recommendation_reason",
  input: Schema.Struct({
    task: TaskMaterial,
    question: Schema.String,
    options: Schema.Array(Schema.Struct({ label: Schema.String, gains: Schema.Array(Point), costs: Schema.Array(Point) })),
    recommended: Schema.String,
  }),
  output: Schema.Struct({ reason: Schema.String }),
  instructions: (input) => `分かれ道（question）で「${input.recommended}」を勧める理由を、得るもの・失うものを踏まえて 1〜2 文で書いてください。選ぶのはユーザーです。`,
});
