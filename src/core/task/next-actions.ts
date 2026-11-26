import { Option, Schema } from "effect";

/**
 * Task の「次にやること」。手順の並びで持ち、各手順は直列（前が済んでから）か並列（前と一緒に）かを持つ。
 * 分かれ道（decision）は選んだ側の手順の並びに進む。
 */
export const EFFORTS = ["easy", "normal", "hard", "tedious"] as const;
export type Effort = (typeof EFFORTS)[number];

type StepBase = { id: string; title: string; effort: Effort; mode: "serial" | "parallel"; status: "todo" | "done" };
/** アプリが GitHub を見て、成り立ったら待つ手順を済ませる条件 */
export type WaitCondition =
  | { kind: "pull_request_opened"; repository: string; query: string }
  | { kind: "review_submitted"; pullUrl: string; since?: string }
  | { kind: "merged"; pullUrl: string }
  /** pullUrl の PR の merge commit が、repository で query に合う開いた PR（deploy の PR など）に入る */
  | { kind: "included_in_pull_request"; repository: string; query: string; pullUrl: string }
  /** pullUrl の PR の merge commit を含む commit で、ワークフロー（ファイル名）が成功する */
  | { kind: "workflow_succeeded"; repository: string; workflow: string; pullUrl: string }
  /** 何を待つかが分からない待ち（返信待ちなど）。元の項目に since より後で動きがあったら済ませる */
  | { kind: "item_changed"; since?: string };
/** wait: 自分では進められず、何か（依存先の PR が出るなど）を待つ手順。手間は持たないものとして扱う */
/** resolve_conflicts: アプリが Claude Code にコンフリクトを直させる / push_conflict_resolution: 直した内容を確かめて push する */
export type ActionStep = StepBase & {
  kind: "manual" | "wait" | "merge_pull_request" | "fix_and_push" | "resolve_conflicts" | "push_conflict_resolution" | "process_mail";
  until?: WaitCondition;
};
/** process_mail: アプリがメールの一覧を見せ、承認したものを Gmail で確認済みにする（アーカイブ）かゴミ箱に入れる */
export const ACTION_KINDS = ["manual", "wait", "merge_pull_request", "fix_and_push", "resolve_conflicts", "push_conflict_resolution", "process_mail"] as const;
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

/** いま着手できるのが待つ手順だけか（待ちのレーンに出す） */
export function isWaitingOnly(plan: NextActionPlan): boolean {
  const current = currentSteps(plan);
  return current.length > 0 && current.every((step) => step.kind === "wait");
}

/** 考え直す前に済んだ手順。選んだ分かれ道は「決めたこと: 選んだもの」の済んだ手順にして残す */
export function doneHistory(plan: NextActionPlan): ActionStep[] {
  return expand(plan.steps)
    .filter((step) => step.status === "done")
    .map((step, index): ActionStep => {
      const base = { id: `h${index + 1}`, effort: step.effort, mode: "serial" as const, status: "done" as const };
      if (step.kind !== "decision") return { ...base, kind: step.kind, title: step.title };
      const chosen = step.options.find((option) => option.key === step.chosen)?.label;
      return { ...base, kind: "manual", title: chosen === undefined ? step.title : `${step.title}: ${chosen}` };
    });
}

/** 定期の Task のひな形にする。済んだ印・選んだ分かれ道・待つ条件（その回だけのもの）を外す */
export function templateOf(plan: NextActionPlan): NextActionPlan {
  const fresh = (steps: ReadonlyArray<Step>): Step[] =>
    steps.map((step): Step => {
      if (step.kind === "decision") {
        const { chosen: _chosen, ...rest } = step;
        return { ...rest, status: "todo", options: step.options.map((option) => ({ ...option, steps: fresh(option.steps) })) };
      }
      const { until: _until, ...rest } = step;
      return { ...rest, status: "todo" };
    });
  return { steps: fresh(plan.steps) };
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

export const conflictPlan = (): NextActionPlan => ({
  steps: [
    { id: "resolve", kind: "resolve_conflicts", title: "Claude Code にコンフリクトを直させる", effort: "easy", mode: "serial", status: "todo" },
    { id: "push", kind: "push_conflict_resolution", title: "直した内容を確かめて、PR に push する", effort: "easy", mode: "serial", status: "todo" },
  ],
});

/** AI が返す待つ条件。JSON Schema の都合で項目は平らに持ち、kind に要らない項目は空文字 */
export type ProposedWaitCondition = {
  kind: Exclude<WaitCondition["kind"], "item_changed"> | "none";
  repository: string;
  query: string;
  pullUrl: string;
};

/** AI が考えた手順。type がなければ手作業 */
export type ProposedStep = {
  title: string;
  effort: Effort;
  mode: "serial" | "parallel";
  type?: ActionStep["kind"] | undefined;
  until?: ProposedWaitCondition | undefined;
  options?: ReadonlyArray<{ label: string; steps: ReadonlyArray<Omit<ProposedStep, "options">> }> | undefined;
};

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PULL_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

/** AI が返した条件のうち、アプリが確かめられる形のものだけを残す（形が崩れていれば、手で済ませる待つ手順になる） */
const WORKFLOW_FILE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

/** 形が崩れた条件は、元の項目の動きを待つ条件にする（待ちを人に戻さないため） */
function waitConditionOf(proposed: ProposedWaitCondition | undefined, now: string | undefined): WaitCondition | undefined {
  if (proposed === undefined) return undefined;
  const fallback: WaitCondition = now === undefined ? { kind: "item_changed" } : { kind: "item_changed", since: now };
  return checkedWaitCondition(proposed, now) ?? fallback;
}

function checkedWaitCondition(proposed: ProposedWaitCondition, now: string | undefined): WaitCondition | undefined {
  switch (proposed.kind) {
    case "included_in_pull_request":
      return REPOSITORY_PATTERN.test(proposed.repository) && proposed.query.trim() !== "" && PULL_URL_PATTERN.test(proposed.pullUrl)
        ? { kind: "included_in_pull_request", repository: proposed.repository, query: proposed.query.trim(), pullUrl: proposed.pullUrl }
        : undefined;
    case "workflow_succeeded":
      return REPOSITORY_PATTERN.test(proposed.repository) && WORKFLOW_FILE.test(proposed.query.trim()) && PULL_URL_PATTERN.test(proposed.pullUrl)
        ? { kind: "workflow_succeeded", repository: proposed.repository, workflow: proposed.query.trim(), pullUrl: proposed.pullUrl }
        : undefined;
    case "pull_request_opened":
      return REPOSITORY_PATTERN.test(proposed.repository) && proposed.query.trim() !== ""
        ? { kind: "pull_request_opened", repository: proposed.repository, query: proposed.query.trim() }
        : undefined;
    case "review_submitted":
      if (!PULL_URL_PATTERN.test(proposed.pullUrl)) return undefined;
      return now === undefined ? { kind: "review_submitted", pullUrl: proposed.pullUrl } : { kind: "review_submitted", pullUrl: proposed.pullUrl, since: now };
    case "merged":
      return PULL_URL_PATTERN.test(proposed.pullUrl) ? { kind: "merged", pullUrl: proposed.pullUrl } : undefined;
    case "none":
      return undefined;
  }
}

function actionStepOf(
  base: StepBase,
  step: { type?: ActionStep["kind"] | undefined; until?: ProposedWaitCondition | undefined },
  now: string | undefined,
): ActionStep {
  const kind = step.type ?? "manual";
  const until = kind === "wait" ? waitConditionOf(step.until, now) : undefined;
  return until === undefined ? { ...base, kind } : { ...base, kind, until };
}

/** AI が考えた手順の並びを、手順の並びに変える。id は位置から決める。now はレビューを待ち始めた時刻 */
export function planFromProposedSteps(proposed: ReadonlyArray<ProposedStep>, now?: string): NextActionPlan {
  const steps = proposed.map((step, index): Step => {
    const id = `s${index + 1}`;
    const base = { id, title: step.title, effort: step.effort, mode: step.mode, status: "todo" as const };
    if (step.options === undefined || step.options.length === 0) return actionStepOf(base, step, now);
    return {
      ...base,
      kind: "decision",
      options: step.options.map((option, optionIndex) => {
        const key = `o${optionIndex + 1}`;
        return {
          key,
          label: option.label,
          steps: option.steps.map((child, childIndex) =>
            actionStepOf(
              { id: `${id}.${key}.s${childIndex + 1}`, title: child.title, effort: child.effort, mode: child.mode, status: "todo" },
              child,
              now,
            ),
          ),
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
export function planFromDependencyReview(
  review: {
    conclusion: "mergeable" | "mergeable_after_fix" | "not_mergeable";
    canMergeAsIs: boolean;
    fixEffort?: Effort | undefined;
    nextActions?: ReadonlyArray<ProposedStep> | undefined;
  },
  now?: string,
): NextActionPlan {
  if (review.nextActions !== undefined && review.nextActions.length > 0) return planFromProposedSteps(review.nextActions, now);
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
const WaitConditionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pull_request_opened"), repository: Schema.String, query: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("review_submitted"), pullUrl: Schema.String, since: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("merged"), pullUrl: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("item_changed"), since: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("included_in_pull_request"), repository: Schema.String, query: Schema.String, pullUrl: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("workflow_succeeded"), repository: Schema.String, workflow: Schema.String, pullUrl: Schema.String }),
]);
const ActionStepSchema = Schema.Struct({ ...StepBaseSchema, kind: Schema.Literals(ACTION_KINDS), until: Schema.optionalKey(WaitConditionSchema) });
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

/**
 * メルマガ・お知らせの送り主の Task の次にやること。アプリで決める（AI に考えさせるほどの中身がないため）。
 * 片付ける手順は済みにしない: 新しいメールが届けば同じ手順でまた片付けるため
 */
export function senderPlan(group: { senderName: string; pending: number; suggestUnsubscribe: boolean }): NextActionPlan {
  const trash: Step = { id: "process", kind: "process_mail", title: `受信トレイの ${group.pending} 通を確かめて、確認済みにするかゴミ箱に入れる`, effort: "easy", mode: "serial", status: "todo" };
  if (!group.suggestUnsubscribe) return { steps: [trash] };
  const manual = (id: string, title: string): Step => ({ id, kind: "manual", title, effort: "easy", mode: "serial", status: "todo" });
  return {
    steps: [
      trash,
      {
        id: "subscription",
        kind: "decision",
        title: `${group.senderName} のメールはほとんど読まずに片付けている。配信を続けるか決める`,
        effort: "easy",
        mode: "parallel",
        status: "todo",
        options: [
          { key: "unsubscribe", label: "配信を解除する", steps: [manual("unsubscribe", `${group.senderName} のメールにある配信停止のリンクから解除する`)] },
          { key: "filter", label: "フィルタで受信トレイを飛ばす", steps: [manual("filter", `Gmail で ${group.senderName} のメールが受信トレイをスキップするフィルタを作る`)] },
          { key: "keep", label: "このまま受け取る", steps: [] },
        ],
      },
    ],
  };
}
