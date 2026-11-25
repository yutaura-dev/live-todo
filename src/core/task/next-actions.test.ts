import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import {
  chooseOption,
  completeStep,
  conflictPlan,
  currentSteps,
  decodePlan,
  type NextActionPlan,
  planFromDependencyReview,
  planFromProposedSteps,
  reopenStep,
  taskEffort,
} from "./next-actions.js";

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

describe("AI が考えた次にやること（依存更新の PR）", () => {
  it("回答に次にやることがあれば、決まった型ではなくそれを使う（待つ・手作業・merge などの種類つき）", () => {
    const plan = planFromDependencyReview(
      review({
        conclusion: "not_mergeable",
        nextActions: [
          { title: "Dependency Dashboard で CLI v3 の PR を作らせる", type: "manual", effort: "easy", mode: "serial", options: [] },
          { title: "CLI v3 の PR が出るのを待つ", type: "wait", effort: "easy", mode: "serial", options: [] },
          { title: "CLI v3 と action v2 をまとめて移行する", type: "manual", effort: "tedious", mode: "serial", options: [] },
        ],
      }),
    );

    assert.deepStrictEqual(plan.steps.map((step) => step.kind), ["manual", "wait", "manual"]);
    assert.deepStrictEqual(titles(plan), ["Dependency Dashboard で CLI v3 の PR を作らせる（easy）"]);
  });

  it("merge の手順は、アプリから merge できる手順にする", () => {
    const plan = planFromDependencyReview(
      review({ nextActions: [{ title: "PR を merge する", type: "merge_pull_request", effort: "easy", mode: "serial", options: [] }] }),
    );

    assert.strictEqual(currentSteps(plan)[0]?.kind, "merge_pull_request");
  });
});

describe("待つ条件", () => {
  it("AI が返した待つ条件を、アプリが確かめられる形で手順に持たせる（条件がなければ持たせない）", () => {
    const plan = planFromProposedSteps(
      [
        {
          title: "CLI v3 の PR が出るのを待つ",
          type: "wait",
          effort: "easy",
          mode: "serial",
          until: { kind: "pull_request_opened", repository: "acme/app", query: "@changesets/cli v3", pullUrl: "" },
        },
        { title: "レビューを待つ", type: "wait", effort: "easy", mode: "serial", until: { kind: "review_submitted", repository: "", query: "", pullUrl: "https://github.com/acme/app/pull/1" } },
        { title: "返事を待つ", type: "wait", effort: "easy", mode: "serial", until: { kind: "none", repository: "", query: "", pullUrl: "" } },
      ],
      "2026-11-25T00:00:00.000Z",
    );

    assert.deepStrictEqual(
      plan.steps.map((step) => (step.kind === "wait" ? step.until : undefined)),
      [
        { kind: "pull_request_opened", repository: "acme/app", query: "@changesets/cli v3" },
        { kind: "review_submitted", pullUrl: "https://github.com/acme/app/pull/1", since: "2026-11-25T00:00:00.000Z" },
        undefined,
      ],
    );
  });

  it("待つ条件を持つ手順も、保存して読み直せる", () => {
    const plan = planFromProposedSteps(
      [{ title: "merge を待つ", type: "wait", effort: "easy", mode: "serial", until: { kind: "merged", repository: "", query: "", pullUrl: "https://github.com/acme/app/pull/1" } }],
      "2026-11-25T00:00:00.000Z",
    );

    assert.deepStrictEqual(decodePlan(JSON.parse(JSON.stringify(plan))), Option.some(plan));
  });
});

describe("待つ手順", () => {
  const wait = { id: "w", kind: "wait" as const, title: "待つ", effort: "easy" as const, mode: "serial" as const, status: "todo" as const };

  it("いま着手できるのが待つ手順だけなら、Task の難易度はない（Todo の最後に並ぶ）", () => {
    assert.isUndefined(taskEffort({ steps: [wait] }));
  });

  it("並列で着手できる手順があれば、待つ手順は難易度に数えない", () => {
    const easy = { ...wait, id: "e", kind: "manual" as const, effort: "normal" as const, mode: "parallel" as const };
    assert.strictEqual(taskEffort({ steps: [wait, easy] }), "normal");
  });
});

describe("conflictPlan", () => {
  it("コンフリクトは、アプリで直させてから、確かめて push する（どちらもボタン 1 つで済むので簡単）", () => {
    const plan = conflictPlan();

    assert.deepStrictEqual(
      plan.steps.map((step) => [step.kind, step.effort, step.mode]),
      [
        ["resolve_conflicts", "easy", "serial"],
        ["push_conflict_resolution", "easy", "serial"],
      ],
    );
    assert.deepStrictEqual(decodePlan(JSON.parse(JSON.stringify(plan))), Option.some(plan));
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
