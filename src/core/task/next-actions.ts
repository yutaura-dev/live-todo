import { Option, Schema } from "effect";

/**
 * Task の「次にやること」。手順の並びで持ち、各手順は直列（前が済んでから）か並列（前と一緒に）かを持つ。
 * 分かれ道（decision）は選んだ側の手順の並びに進む。
 */
export const EFFORTS = ["easy", "normal", "hard", "tedious"] as const;
export type Effort = (typeof EFFORTS)[number];

type StepBase = { id: string; title: string; effort: Effort; mode: "serial" | "parallel"; status: "todo" | "done" };
/** wait: 自分では進められず、何か（依存先の PR が出るなど）を待つ手順。手間は持たないものとして扱う */
export type ActionStep = StepBase & { kind: "manual" | "wait" | "merge_pull_request" | "fix_and_push" };
export const ACTION_KINDS = ["manual", "wait", "merge_pull_request", "fix_and_push"] as const;
export type DecisionStep = StepBase & {
  kind: "decision";
  options: ReadonlyArray<{ key: string; label: string; steps: ReadonlyArray<Step> }>;
  chosen?: string;
};
export type Step = ActionStep | DecisionStep;
export type NextActionPlan = { steps: ReadonlyArray<Step> };

/** 分かれ道を選んだ側の手順で展開した、一列の並び */
function expand(steps: ReadonlyArray<Step>): Step[] {
  return steps.flatMap((step) => {
    if (step.kind !== "decision" || step.chosen === undefined) return [step];
    const option = step.options.find((candidate) => candidate.key === step.chosen);
    return [step, ...expand(option?.steps ?? [])];
  });
}

/** いま着手できる手順。最初の済んでいない手順と、その後ろに並列で続く手順 */
export function currentSteps(plan: NextActionPlan): Step[] {
  const all = expand(plan.steps);
  const first = all.findIndex((step) => step.status === "todo");
  if (first === -1) return [];
  const current = [all[first]!];
  for (let index = first + 1; index < all.length && all[index]!.mode === "parallel"; index++) {
    if (all[index]!.status === "todo") current.push(all[index]!);
  }
  return current;
}

function mapSteps(steps: ReadonlyArray<Step>, change: (step: Step) => Step): Step[] {
  return steps.map((step) => {
    const changed = change(step);
    if (changed.kind !== "decision") return changed;
    return { ...changed, options: changed.options.map((option) => ({ ...option, steps: mapSteps(option.steps, change) })) };
  });
}

/** Task の難易度。いま着手できる手順のうち、いちばん手間の少ないもの（直列なら先頭、並列ならその中で最も簡単なもの） */
export function taskEffort(plan: NextActionPlan): Effort | undefined {
  const efforts = currentSteps(plan)
    .filter((step) => step.kind !== "wait")
    .map((step) => EFFORTS.indexOf(step.effort));
  return efforts.length === 0 ? undefined : EFFORTS[Math.min(...efforts)];
}

export const completeStep = (plan: NextActionPlan, id: string): NextActionPlan => ({
  steps: mapSteps(plan.steps, (step) => (step.id === id ? { ...step, status: "done" } : step)),
});

/** 済んだにした手順を戻す。分かれ道なら、選ぶ前に戻す */
export const reopenStep = (plan: NextActionPlan, id: string): NextActionPlan => ({
  steps: mapSteps(plan.steps, (step) => {
    if (step.id !== id) return step;
    if (step.kind !== "decision") return { ...step, status: "todo" };
    const { chosen: _chosen, ...rest } = step;
    return { ...rest, status: "todo" };
  }),
});

export const chooseOption = (plan: NextActionPlan, id: string, key: string): NextActionPlan => ({
  steps: mapSteps(plan.steps, (step) => (step.id === id && step.kind === "decision" ? { ...step, chosen: key, status: "done" } : step)),
});

/** AI が考えた手順。type がなければ手作業 */
export type ProposedStep = {
  title: string;
  effort: Effort;
  mode: "serial" | "parallel";
  type?: ActionStep["kind"] | undefined;
  options?: ReadonlyArray<{ label: string; steps: ReadonlyArray<Omit<ProposedStep, "options">> }> | undefined;
};

/** AI が考えた手順の並びを、手順の並びに変える。id は位置から決める */
export function planFromProposedSteps(proposed: ReadonlyArray<ProposedStep>): NextActionPlan {
  const steps = proposed.map((step, index): Step => {
    const id = `s${index + 1}`;
    const base = { id, title: step.title, effort: step.effort, mode: step.mode, status: "todo" as const };
    if (step.options === undefined || step.options.length === 0) return { ...base, kind: step.type ?? "manual" };
    return {
      ...base,
      kind: "decision",
      options: step.options.map((option, optionIndex) => {
        const key = `o${optionIndex + 1}`;
        return {
          key,
          label: option.label,
          steps: option.steps.map((child, childIndex) => ({
            id: `${id}.${key}.s${childIndex + 1}`,
            kind: child.type ?? ("manual" as const),
            title: child.title,
            effort: child.effort,
            mode: child.mode,
            status: "todo" as const,
          })),
        };
      }),
    };
  });
  return { steps };
}

/**
 * 依存更新の PR の調査から、次にやることを決める。AI が考えた手順があればそれを使い、
 * なければ（その項目を足す前の調査）結論から決まった型で作る。
 */
export function planFromDependencyReview(review: {
  conclusion: "mergeable" | "mergeable_after_fix" | "not_mergeable";
  canMergeAsIs: boolean;
  fixEffort?: Effort | undefined;
  nextActions?: ReadonlyArray<ProposedStep> | undefined;
}): NextActionPlan {
  if (review.nextActions !== undefined && review.nextActions.length > 0) return planFromProposedSteps(review.nextActions);
  const merge = (prefix: string): ActionStep => ({
    id: `${prefix}merge`,
    kind: "merge_pull_request",
    title: "PR を merge する",
    effort: "easy",
    mode: "serial",
    status: "todo",
  });
  const fixThenMerge = (prefix: string): Step[] => [
    { id: `${prefix}fix`, kind: "fix_and_push", title: "修正を行い、PR に push する", effort: review.fixEffort ?? "normal", mode: "serial", status: "todo" },
    merge(prefix),
  ];

  switch (review.conclusion) {
    case "mergeable":
      return { steps: [merge("")] };
    case "mergeable_after_fix":
      if (!review.canMergeAsIs) return { steps: fixThenMerge("") };
      return {
        steps: [
          {
            id: "decide",
            kind: "decision",
            title: "修正を行うか、そのまま merge するか決める",
            effort: "easy",
            mode: "serial",
            status: "todo",
            options: [
              { key: "fix", label: "修正する", steps: fixThenMerge("fix.") },
              { key: "as_is", label: "そのまま merge する", steps: [merge("as_is.")] },
            ],
          },
        ],
      };
    case "not_mergeable":
      return {
        steps: [
          { id: "config", kind: "manual", title: "renovate / dependabot の設定を直す", effort: "normal", mode: "serial", status: "todo" },
          { id: "close", kind: "manual", title: "PR を閉じる", effort: "easy", mode: "parallel", status: "todo" },
        ],
      };
  }
}

const StepBaseSchema = {
  id: Schema.String,
  title: Schema.String,
  effort: Schema.Literals(EFFORTS),
  mode: Schema.Literals(["serial", "parallel"]),
  status: Schema.Literals(["todo", "done"]),
};
const ActionStepSchema = Schema.Struct({ ...StepBaseSchema, kind: Schema.Literals(ACTION_KINDS) });
interface DecisionStepEncoded extends Schema.Struct.Encoded<typeof StepBaseSchema> {
  readonly kind: "decision";
  readonly options: ReadonlyArray<{ readonly key: string; readonly label: string; readonly steps: ReadonlyArray<StepEncoded> }>;
  readonly chosen?: string;
}
type StepEncoded = typeof ActionStepSchema.Encoded | DecisionStepEncoded;
const StepSchema: Schema.Codec<Step, StepEncoded> = Schema.Union([
  ActionStepSchema,
  Schema.Struct({
    ...StepBaseSchema,
    kind: Schema.Literal("decision"),
    options: Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String, steps: Schema.Array(Schema.suspend(() => StepSchema)) })),
    chosen: Schema.optionalKey(Schema.String),
  }),
]);
const PlanSchema = Schema.Struct({ steps: Schema.Array(StepSchema) });

/** DB に保存した次にやることを読む。形が違えば none（画面に出さない） */
export const decodePlan = (value: unknown): Option.Option<NextActionPlan> => Schema.decodeUnknownOption(PlanSchema)(value);
