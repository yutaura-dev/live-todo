import { assert, describe, it } from "@effect/vitest";
import { chooseOption, completeStep, currentSteps, type NextActionPlan, planFromDependencyReview, reopenStep } from "./next-actions.js";

const review = (overrides: Record<string, unknown> = {}) => ({
  conclusion: "mergeable" as const,
  impact: "",
  requiredChanges: "",
  blockers: "",
  configChanges: "",
  canMergeAsIs: false,
  mergeAsIsNote: "",
  fixEffort: "normal" as const,
  ...overrides,
});

const titles = (plan: NextActionPlan) => currentSteps(plan).map((step) => `${step.title}（${step.effort}）`);

describe("planFromDependencyReview", () => {
  it("merge 可能なら、merge するだけ（簡単）", () => {
    const plan = planFromDependencyReview(review());

    assert.deepStrictEqual(titles(plan), ["PR を merge する（easy）"]);
    assert.strictEqual(currentSteps(plan)[0]?.kind, "merge_pull_request");
  });

  it("修正すれば merge 可能なら、修正して push してから merge する（直列。修正の手間は AI の見積もり）", () => {
    const plan = planFromDependencyReview(review({ conclusion: "mergeable_after_fix", fixEffort: "hard" }));

    assert.deepStrictEqual(titles(plan), ["修正を行い、PR に push する（hard）"]);
    const afterFix = completeStep(plan, currentSteps(plan)[0]!.id);
    assert.deepStrictEqual(titles(afterFix), ["PR を merge する（easy）"]);
  });

  it("そのまま merge してもよいなら、修正するか決める分かれ道から始める", () => {
    const plan = planFromDependencyReview(review({ conclusion: "mergeable_after_fix", canMergeAsIs: true }));
    const decision = currentSteps(plan)[0]!;

    assert.strictEqual(decision.kind, "decision");
    assert.deepStrictEqual(titles(plan), ["修正を行うか、そのまま merge するか決める（easy）"]);

    assert.deepStrictEqual(titles(chooseOption(plan, decision.id, "fix")), ["修正を行い、PR に push する（normal）"]);
    assert.deepStrictEqual(titles(chooseOption(plan, decision.id, "as_is")), ["PR を merge する（easy）"]);
  });

  it("merge できないなら、設定を直すことと PR を閉じることを同時に進められる（並列）", () => {
    const plan = planFromDependencyReview(review({ conclusion: "not_mergeable" }));

    assert.deepStrictEqual(titles(plan), ["renovate / dependabot の設定を直す（normal）", "PR を閉じる（easy）"]);
  });
});

describe("reopenStep", () => {
  it("済んだ手順を、まだの状態に戻す", () => {
    const plan = planFromDependencyReview(review({ conclusion: "mergeable_after_fix" }));
    const fix = currentSteps(plan)[0]!;

    const reopened = reopenStep(completeStep(plan, fix.id), fix.id);

    assert.deepStrictEqual(currentSteps(reopened).map((step) => step.id), [fix.id]);
  });

  it("選んだ分かれ道を戻すと、選ぶ前に戻る", () => {
    const plan = planFromDependencyReview(review({ conclusion: "mergeable_after_fix", canMergeAsIs: true }));
    const decision = currentSteps(plan)[0]!;

    const reopened = reopenStep(chooseOption(plan, decision.id, "as_is"), decision.id);

    assert.deepStrictEqual(titles(reopened), ["修正を行うか、そのまま merge するか決める（easy）"]);
    const step = reopened.steps[0]!;
    assert.isTrue(step.kind === "decision" && step.chosen === undefined);
  });
});

describe("currentSteps", () => {
  const plan: NextActionPlan = {
    steps: [
      { id: "a", kind: "manual", title: "A", effort: "easy", mode: "serial", status: "todo" },
      { id: "b", kind: "manual", title: "B", effort: "easy", mode: "parallel", status: "todo" },
      { id: "c", kind: "manual", title: "C", effort: "easy", mode: "serial", status: "todo" },
    ],
  };

  it("並列の手順は、前の手順と一緒に着手できる。直列の手順は、前が済むまで待つ", () => {
    assert.deepStrictEqual(currentSteps(plan).map((step) => step.id), ["a", "b"]);
    assert.deepStrictEqual(currentSteps(completeStep(plan, "a")).map((step) => step.id), ["b"]);
    assert.deepStrictEqual(currentSteps(completeStep(completeStep(plan, "a"), "b")).map((step) => step.id), ["c"]);
  });

  it("すべて済んだら、着手できる手順はない", () => {
    assert.lengthOf(currentSteps(completeStep(completeStep(completeStep(plan, "a"), "b"), "c")), 0);
  });
});
