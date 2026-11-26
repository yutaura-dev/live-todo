import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { NEXT_ACTION_PLAN_JSON_SCHEMA, decodeProposedPlan, nextActionPrompt, planFromProposal } from "./next-action-planning.js";

const NONE = { kind: "none" as const, repository: "", query: "", pullUrl: "" };

describe("planFromProposal", () => {
  it("AI が返した手順を、手順の並び（id・未着手）に変える", () => {
    const plan = planFromProposal({
      steps: [
        { title: "Slack で状況を聞く", type: "manual", until: NONE, effort: "easy", mode: "serial", options: [] },
        { title: "PR をレビューする", type: "manual", until: NONE, effort: "hard", mode: "parallel", options: [] },
        { title: "レビューを待つ", type: "wait", until: NONE, effort: "easy", mode: "serial", options: [] },
      ],
    });

    assert.deepStrictEqual(plan.steps.map((step) => [step.id, step.kind, step.title, step.effort, step.mode, step.status]), [
      ["s1", "manual", "Slack で状況を聞く", "easy", "serial", "todo"],
      ["s2", "manual", "PR をレビューする", "hard", "parallel", "todo"],
      ["s3", "wait", "レビューを待つ", "easy", "serial", "todo"],
    ]);
  });

  it("選択肢のある手順は分かれ道にし、選んだ側の手順を持たせる", () => {
    const plan = planFromProposal({
      steps: [
        {
          title: "対応するか決める",
          type: "manual",
          until: NONE,
          effort: "easy",
          mode: "serial",
          options: [
            { label: "対応する", steps: [{ title: "直す", type: "manual", until: NONE, effort: "normal", mode: "serial" }] },
            { label: "断る", steps: [{ title: "返信する", type: "manual", until: NONE, effort: "easy", mode: "serial" }] },
          ],
        },
      ],
    });
    const decision = plan.steps[0]!;

    assert.strictEqual(decision.kind, "decision");
    if (decision.kind !== "decision") return;
    assert.deepStrictEqual(decision.options.map((option) => [option.key, option.label, option.steps.map((step) => step.id)]), [
      ["o1", "対応する", ["s1.o1.s1"]],
      ["o2", "断る", ["s1.o2.s1"]],
    ]);
  });
});

describe("decodeProposedPlan", () => {
  it.effect("手順が 1 つもない回答はエラーにする（すべての Task に次にやることを入れるため）", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeProposedPlan({ steps: [] }));
      assert.strictEqual(error._tag, "SchemaError");
    }));

  it.effect("知らない手間はエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeProposedPlan({ steps: [{ title: "x", type: "manual", until: NONE, effort: "quick", mode: "serial", options: [] }] }));
      assert.strictEqual(error._tag, "SchemaError");
    }));
});

describe("nextActionPrompt", () => {
  const prompt = nextActionPrompt({ title: "障害の調査依頼（acme/app）", contextDir: "/work/task-1/context" });

  it("Task のタイトルと、集めた情報のファイルを伝える", () => {
    assert.include(prompt, "障害の調査依頼（acme/app）");
    assert.include(prompt, "/work/task-1/context/task.json");
  });

  it("リポジトリがあれば、CLAUDE.md・docs・ワークフローから merge 後の手順（deploy など）を読み取らせる。読み取れないことは足させない", () => {
    const withRepository = nextActionPrompt({ title: "x", contextDir: "/work/task-1/context", repository: "/work/task-1/repo/acme/app" });

    assert.include(withRepository, "/work/task-1/repo/acme/app");
    assert.include(withRepository, ".github/workflows");
    assert.include(withRepository, "included_in_pull_request");
    assert.include(withRepository, "推測");
    assert.notInclude(prompt, ".github/workflows");
  });

  it("考え直すときは、済んだ手順を繰り返さず残りだけを考えるよう伝える", () => {
    assert.include(nextActionPrompt({ title: "x", contextDir: "/c", replanning: true }), "済んだ手順");
    assert.notInclude(prompt, "済んだ手順");
  });

  it("決まった周期で繰り返す仕事だと読み取れるときだけ、定期の Task の提案（頻度・何をするか・理由）を書かせる", () => {
    assert.include(prompt, "recurring");
    assert.include(prompt, "繰り返す");
    assert.deepStrictEqual(NEXT_ACTION_PLAN_JSON_SCHEMA.properties.recurring.required, ["suggest", "day", "leadDays", "title", "note", "reason"]);
  });

  it("Task が追う PR を merge する手順は、アプリから merge できる手順にさせる", () => {
    assert.include(prompt, "merge_pull_request");
  });

  it("待つ手順には、アプリが見張れるよう何を待つか（レビュー・merge）を書かせる", () => {
    assert.include(prompt, "review_submitted");
    assert.include(prompt, "merged");
  });

  it("アプリが集めた PR の状態で分かることを、確認する手順にしないよう伝え、相手待ちは待つ手順にさせる", () => {
    assert.include(prompt, "/work/task-1/context/pr-state.json");
    assert.include(prompt, "確認する手順");
    assert.include(prompt, "wait");
  });

  it("手間の基準（10 秒・5 分・15 分）をプロンプトの中にだけ持つ", () => {
    assert.include(prompt, "10 秒");
    assert.include(prompt, "5 分");
    assert.include(prompt, "15 分");
  });
});

describe("NEXT_ACTION_PLAN_JSON_SCHEMA", () => {
  it("手順は 1 つ以上で、内容・種類（手作業か待つか）・手間・直列か並列か・選択肢を持つ", () => {
    assert.strictEqual(NEXT_ACTION_PLAN_JSON_SCHEMA.properties.steps.minItems, 1);
    assert.deepStrictEqual(NEXT_ACTION_PLAN_JSON_SCHEMA.properties.steps.items.required, ["title", "type", "until", "effort", "mode", "options"]);
    assert.deepStrictEqual(NEXT_ACTION_PLAN_JSON_SCHEMA.properties.steps.items.properties.until.properties.kind.enum, [
      "pull_request_opened",
      "review_submitted",
      "merged",
      "included_in_pull_request",
      "workflow_succeeded",
      "none",
    ]);
    assert.deepStrictEqual(NEXT_ACTION_PLAN_JSON_SCHEMA.properties.steps.items.properties.type.enum, ["manual", "wait", "merge_pull_request"]);
  });
});

describe("手順のリンク", () => {
  it("Web でやる手順に、公式のサイトの開く先を付けさせる（メールの中のリンクは使わせない）", () => {
    const prompt = nextActionPrompt({ title: "x", contextDir: "/work/x" });
    assert.include(prompt, "link");
    assert.include(prompt, "公式");
    assert.include(prompt, "メールの中のリンク");
    assert.include(JSON.stringify(NEXT_ACTION_PLAN_JSON_SCHEMA), "link");
  });

  it("回答のリンクを手順に持たせ、空のリンクは持たせない", () =>
    Effect.runSync(
      Effect.gen(function* () {
        const proposal = yield* decodeProposedPlan({
          steps: [
            { title: "ログインする", type: "manual", until: { kind: "none", repository: "", query: "", pullUrl: "", workflow: "" }, effort: "easy", mode: "serial", options: [], link: { url: "https://trade.sbivc.co.jp/", label: "VCTRADE" } },
            { title: "決める", type: "manual", until: { kind: "none", repository: "", query: "", pullUrl: "", workflow: "" }, effort: "easy", mode: "serial", options: [], link: { url: "", label: "" } },
          ],
        });
        const plan = planFromProposal(proposal);
        assert.deepInclude(plan.steps[0], { link: { url: "https://trade.sbivc.co.jp/", label: "VCTRADE" } });
        assert.notProperty(plan.steps[1]!, "link");
      }),
    ));
});
