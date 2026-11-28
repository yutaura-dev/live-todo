import { Schema } from "effect";
import { Decision } from "effect/ai";
import type { Answer } from "../../shared/answer.js";
import { TaskMaterial } from "../../shared/materials.js";
import { Aspect } from "../../shared/vocabulary.js";
import { topLabelAtLeast } from "../interpret.js";
import { defineQuestion } from "../question.js";

// 選ぶ分かれ道（action-definition.value.ts の Decision・Option）の、得るもの・失うものとおすすめ

const OptionDraft = Schema.Struct({
  label: Schema.String,
  /** 選んだらどう進めるか（先の計画の要約・選んでから考える方針） */
  then: Schema.String,
});

const aspectKey = (option: number, aspect: number) => `option${option}_aspect${aspect}`;
export const Comparison = ["良い", "差がない", "悪い"] as const;
export type Comparison = (typeof Comparison)[number];

/** 選択肢ごと・観点ごとに、ほかの選択肢より良い・差がない・悪いを判定する（同じ入力に対する問いなので、1 回のリクエストにまとめる） */
export const optionAspectsQuestion = defineQuestion({
  purpose: "decision-point.option-aspects",
  version: 1,
  input: Schema.Struct({ task: TaskMaterial, question: Schema.String, options: Schema.Array(OptionDraft), aspects: Schema.Array(Aspect) }),
  decisions: (input) =>
    Object.fromEntries(
      input.options.flatMap((option, o) =>
        input.aspects.map((aspect, a) => [
          aspectKey(o, a),
          Decision.classify({
            instructions: `分かれ道「${input.question}」で、選択肢「${option.label}」は、ほかの選択肢と比べて「${aspect}」の観点でどうか。`,
            criteria: { 良い: "ほかの選択肢より良い", 差がない: "ほかの選択肢と差がない", 悪い: "ほかの選択肢より悪い" },
          }),
        ]),
      ),
    ),
});

const ASPECT_THRESHOLD = 0.6;
const MAX_POINTS = 3;

export type AspectPoint = { readonly aspect: Aspect; readonly probability: number };
export type OptionAspects = { readonly gains: ReadonlyArray<AspectPoint>; readonly costs: ReadonlyArray<AspectPoint>; readonly unclear: ReadonlyArray<Aspect> };

/** 答えを選択肢と観点の番号で引く（キーの組み立てを呼ぶ側に漏らさない） */
export const optionAspectAnswer =
  (answers: Readonly<Record<string, Answer<Decision.ClassifyAnswer<Comparison>>>>) =>
  (option: number, aspect: number): Answer<Decision.ClassifyAnswer<Comparison>> =>
    answers[aspectKey(option, aspect)] ?? { _tag: "Unanswered", reason: "Missing" };

/**
 * 「良い」が閾値以上の観点を得るもの、「悪い」が閾値以上を失うものにし、それぞれ確率の高い順に 3 件まで。
 * 「差がない」はどこにも出さない。閾値に届かない・答えなかった観点は、判断できなかった観点にする（迷ったら黙って決めない）。
 */
export function interpretOptionAspects(
  input: { readonly options: ReadonlyArray<unknown>; readonly aspects: ReadonlyArray<Aspect> },
  answerOf: (option: number, aspect: number) => Answer<Decision.ClassifyAnswer<Comparison>>,
): ReadonlyArray<OptionAspects> {
  const top = (points: AspectPoint[]) => points.sort((a, b) => b.probability - a.probability).slice(0, MAX_POINTS);
  return input.options.map((_option, o) => {
    const gains: AspectPoint[] = [];
    const costs: AspectPoint[] = [];
    const unclear: Aspect[] = [];
    input.aspects.forEach((aspect, a) => {
      const decided = topLabelAtLeast(answerOf(o, a), ASPECT_THRESHOLD);
      if (decided === null) unclear.push(aspect);
      else if (decided.label === "良い") gains.push({ aspect, probability: decided.probability });
      else if (decided.label === "悪い") costs.push({ aspect, probability: decided.probability });
    });
    return { gains: top(gains), costs: top(costs), unclear };
  });
}

/** おすすめの選択肢（選ぶ分かれ道だけ）。理由は Generation が書く */
export const recommendationQuestion = defineQuestion({
  purpose: "decision-point.recommendation",
  version: 1,
  input: Schema.Struct({
    task: TaskMaterial,
    question: Schema.String,
    options: Schema.Array(Schema.Struct({ ...OptionDraft.fields, gains: Schema.Array(Aspect), costs: Schema.Array(Aspect) })),
  }),
  decisions: (input) => ({
    recommendation: Decision.classify({
      instructions: `分かれ道「${input.question}」で、この Task（task）にとっていちばんよい選択肢はどれか。得るもの（gains）と失うもの（costs）を天秤にかける。`,
      criteria: Object.fromEntries(input.options.map((option, o) => [`option${o}`, option.label])),
    }),
  }),
});

const RECOMMENDATION_THRESHOLD = 0.7;

/** いちばん確率の高い選択肢が閾値以上のときだけ、その番号。閾値の間・断られた・形に合わないなら勧めない（null） */
export function interpretRecommendation(answer: Answer<Decision.ClassifyAnswer<string>>): number | null {
  const decided = topLabelAtLeast(answer, RECOMMENDATION_THRESHOLD);
  const index = decided === null ? Number.NaN : Number(decided.label.replace(/^option/, ""));
  return Number.isInteger(index) ? index : null;
}
