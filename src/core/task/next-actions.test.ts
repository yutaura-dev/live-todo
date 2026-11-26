import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import {
  chooseOption,
  completeStep,
  conflictPlan,
  currentSteps,
  decodePlan,
  doneHistory,
  type NextActionPlan,
  planFromDependencyReview,
  planFromProposedSteps,
  reopenStep,
  senderPlan,
  stepLinkOf,
  taskEffort, linkOfStep } from "./next-actions.js";

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
  it("AI が返した待つ条件を、アプリが確かめられる形で手順に持たせる（何を待つか分からなければ、元の項目の動きを待つ）", () => {
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
        { kind: "item_changed", since: "2026-11-25T00:00:00.000Z" },
      ],
    );
  });

  it("deploy の PR に入るのを待つ・ワークフローの成功を待つ条件は、リポジトリと自分の PR が揃っていれば持たせる", () => {
    const plan = planFromProposedSteps([
      { title: "deploy の PR に入るのを待つ", type: "wait", effort: "easy", mode: "serial", until: { kind: "included_in_pull_request", repository: "acme/app", query: "Deploy stg", pullUrl: "https://github.com/acme/app/pull/1" } },
      { title: "deploy を待つ", type: "wait", effort: "easy", mode: "serial", until: { kind: "workflow_succeeded", repository: "acme/app", query: "deploy-stg.yml", pullUrl: "https://github.com/acme/app/pull/1" } },
      { title: "壊れた条件", type: "wait", effort: "easy", mode: "serial", until: { kind: "workflow_succeeded", repository: "acme/app", query: "../../evil", pullUrl: "https://github.com/acme/app/pull/1" } },
    ]);

    assert.deepStrictEqual(
      plan.steps.map((step) => (step.kind === "wait" ? step.until?.kind : undefined)),
      ["included_in_pull_request", "workflow_succeeded", "item_changed"],
    );
    assert.deepStrictEqual(decodePlan(JSON.parse(JSON.stringify(plan))), Option.some(plan));
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

describe("doneHistory", () => {
  it("考え直す前に済んだ手順を、選んだ分かれ道も含めて、済んだ手順の並びとして残す（まだの手順は残さない）", () => {
    const plan: NextActionPlan = {
      steps: [
        { id: "s1", kind: "wait", title: "CI を待つ", effort: "easy", mode: "serial", status: "done", until: { kind: "item_changed" } },
        {
          id: "s2",
          kind: "decision",
          title: "レビューを頼むか決める",
          effort: "easy",
          mode: "serial",
          status: "done",
          chosen: "o2",
          options: [
            { key: "o1", label: "頼む", steps: [] },
            { key: "o2", label: "頼まない", steps: [{ id: "s2.o2.s1", kind: "merge_pull_request", title: "merge する", effort: "easy", mode: "serial", status: "todo" }] },
          ],
        },
        { id: "s3", kind: "manual", title: "連絡する", effort: "normal", mode: "serial", status: "todo" },
      ],
    };

    assert.deepStrictEqual(
      doneHistory(plan).map((step) => [step.id, step.kind, step.title, step.status]),
      [
        ["h1", "wait", "CI を待つ", "done"],
        ["h2", "manual", "レビューを頼むか決める: 頼まない", "done"],
      ],
    );
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

describe("senderPlan（メルマガ・お知らせの送り主の Task の次にやること）", () => {
  it("受信トレイのメールを確かめて、確認済みにするかゴミ箱に入れる手順にする（アプリで Gmail に反映する）", () => {
    const plan = senderPlan({ senderName: "Shop", pending: 3, pastInvites: 0, suggestUnsubscribe: false });
    assert.deepStrictEqual(plan.steps.map((step) => [step.kind, step.title]), [["process_mail", "受信トレイの 3 通を確かめて、確認済みにするかゴミ箱に入れる"]]);
  });

  it("日程が過ぎた招待があれば、それを確認済みにする手順を先に出し、ほかのメールの手順は並行してできるようにする", () => {
    const plan = senderPlan({ senderName: "Google カレンダー", pending: 5, pastInvites: 2, suggestUnsubscribe: false });
    assert.deepStrictEqual(plan.steps.map((step) => [step.kind, step.title, step.mode]), [
      ["archive_past_invites", "日程が過ぎた招待 2 通を確認済みにする", "serial"],
      ["process_mail", "受信トレイの 5 通を確かめて、確認済みにするかゴミ箱に入れる", "parallel"],
    ]);
  });

  it("配信の解除を勧める送り主には、配信を続けるかの分かれ道を並行して並べる", () => {
    const plan = senderPlan({ senderName: "Shop", pending: 1, pastInvites: 0, suggestUnsubscribe: true });
    const decision = plan.steps[1]!;
    assert.strictEqual(decision.kind, "decision");
    assert.strictEqual(decision.mode, "parallel");
    assert.include(decision.title, "Shop");
    assert.deepStrictEqual(decision.kind === "decision" ? decision.options.map((option) => option.key) : [], ["unsubscribe", "filter", "keep"]);
    assert.lengthOf(currentSteps(plan), 2);
  });
});

describe("手順のリンク（Web でやる手順を開くボタン）", () => {
  it("https のリンクと名前があれば、手順に持たせる", () => {
    const plan = planFromProposedSteps([{ title: "公式サイトから VCTRADE にログインする", effort: "easy", mode: "serial", type: "manual", link: { url: "https://trade.sbivc.co.jp/", label: "VCTRADE" } }]);
    assert.deepInclude(plan.steps[0], { link: { url: "https://trade.sbivc.co.jp/", label: "VCTRADE" } });
  });

  it("https でない・名前がない・空のリンクは持たせない", () => {
    for (const link of [{ url: "http://example.com", label: "x" }, { url: "javascript:alert(1)", label: "x" }, { url: "https://example.com", label: " " }, { url: "", label: "" }]) {
      const plan = planFromProposedSteps([{ title: "x", effort: "easy", mode: "serial", type: "manual", link }]);
      assert.notProperty(plan.steps[0]!, "link");
    }
  });

  it("保存した手順のリンクを読める", () => {
    const plan = { steps: [{ id: "s1", kind: "manual", title: "x", effort: "easy", mode: "serial", status: "todo", link: { url: "https://example.com", label: "例" } }] };
    assert.deepInclude(Option.getOrThrow(decodePlan(plan)).steps[0], { link: { url: "https://example.com", label: "例" } });
  });

  it("手順の id から、分かれ道の中も含めてリンクを探す", () => {
    const plan = planFromProposedSteps([
      { title: "決める", effort: "easy", mode: "serial", options: [{ label: "続ける", steps: [{ title: "ログインする", effort: "easy", mode: "serial", type: "manual", link: { url: "https://example.com/login", label: "例" } }] }] },
    ]);
    assert.deepStrictEqual(stepLinkOf(plan, "s1.o1.s1"), { url: "https://example.com/login", label: "例" });
    assert.isUndefined(stepLinkOf(plan, "s1"));
  });
});

describe("Gmail の操作の手順（ボタンでアプリが行う）", () => {
  it("ラベル・既読・アーカイブを持つ手順にする（操作のないものは手作業にする）", () => {
    const plan = planFromProposedSteps([
      { title: "レシートラベルを付けて既読にし、アーカイブする", effort: "easy", mode: "serial", type: "gmail_action", gmail: { labels: ["レシート"], markRead: true, archive: true } },
      { title: "何もしない", effort: "easy", mode: "serial", type: "gmail_action", gmail: { labels: [], markRead: false, archive: false } },
    ]);
    assert.deepInclude(plan.steps[0], { kind: "gmail_action", gmail: { labels: ["レシート"], markRead: true, archive: true } });
    assert.deepInclude(plan.steps[1], { kind: "manual" });
  });

  it("保存した Gmail の操作の手順を読める", () => {
    const plan = { steps: [{ id: "s1", kind: "gmail_action", title: "x", effort: "easy", mode: "serial", status: "todo", gmail: { labels: ["レシート"], markRead: true } }] };
    assert.deepInclude(Option.getOrThrow(decodePlan(plan)).steps[0], { gmail: { labels: ["レシート"], markRead: true } });
  });
});

describe("Web ページを開く手順のボタン", () => {
  it("決める手順（分かれ道）にも開く先を付けられ、stepLinkOf で引ける", () => {
    const plan = planFromProposedSteps([
      {
        title: "権限更新のページを読んで承認するか決める",
        effort: "normal",
        mode: "serial",
        link: { url: "https://github.com/settings/installations/1/permissions/update", label: "GitHub の権限更新ページ" },
        options: [{ label: "承認する", steps: [{ title: "承認する", effort: "easy", mode: "serial" }] }],
      },
    ]);
    assert.deepStrictEqual(stepLinkOf(plan, "s1"), { url: "https://github.com/settings/installations/1/permissions/update", label: "GitHub の権限更新ページ" });
  });

  it("開く先がなくても、手順の文に https の URL が書いてあれば、そのページを開く先にする", () => {
    const step = { id: "s1", kind: "decision", title: "権限更新ページ（https://github.com/settings/installations/1/permissions/update）を開き、承認するか決める", effort: "normal", mode: "serial", status: "todo", options: [] } as const;
    assert.deepStrictEqual(linkOfStep(step), { url: "https://github.com/settings/installations/1/permissions/update", label: "ページ" });
  });

  it("http や javascript: の URL は開く先にしない", () => {
    const step = { id: "s1", kind: "manual", title: "http://example.com を開く javascript:alert(1)", effort: "easy", mode: "serial", status: "todo" } as const;
    assert.isUndefined(linkOfStep(step));
  });
});
