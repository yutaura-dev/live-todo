import { assert, describe, it } from "@effect/vitest";
import { planFromProposedSteps } from "../task/next-actions.js";
import { planIssues, scoreTriage } from "./mail-evaluation.js";

describe("scoreTriage（メールを Task にするかの採点）", () => {
  it("正解が task / none の件だけで、取りこぼし・余計な Task・正解率を数える（either は数えない）", () => {
    const report = scoreTriage([
      { id: "a", expected: "task", predicted: "task" },
      { id: "b", expected: "task", predicted: "none" },
      { id: "c", expected: "none", predicted: "task" },
      { id: "d", expected: "none", predicted: "none" },
      { id: "e", expected: "none", predicted: "none" },
      { id: "f", expected: "either", predicted: "task" },
    ]);
    assert.deepStrictEqual(report, { total: 5, correct: 3, accuracy: 0.6, precision: 0.5, recall: 0.5, missed: ["b"], falseTasks: ["c"] });
  });

  it("判定に失敗した件（predicted が failed）は、外れとして数える", () => {
    const report = scoreTriage([{ id: "a", expected: "task", predicted: "failed" }]);
    assert.deepInclude(report, { total: 1, correct: 0, missed: ["a"] });
  });
});

describe("planIssues（手順の担当）", () => {
  it("Claude Code には外に書き込む手順を持たせない・調べるだけの手順を人に残さない", () => {
    const plan = planFromProposedSteps([
      { title: "レビューのコメントに返信する", effort: "easy", mode: "serial", type: "manual", actor: "claude_on_request" },
      { title: "失敗した CI のログを調べて原因をまとめる", effort: "normal", mode: "serial", type: "manual", actor: "human" },
    ]);
    assert.deepStrictEqual(planIssues(plan), ["claude_cannot_write", "human_could_research"]);
  });

  it("調べる手順を Claude Code に、書き込む・決める手順を人にした手順は問題なし", () => {
    const plan = planFromProposedSteps([
      { title: "失敗した CI のログを調べて原因をまとめる", effort: "normal", mode: "serial", type: "manual", actor: "claude_auto" },
      { title: "直した内容を push する", effort: "normal", mode: "serial", type: "manual", actor: "human" },
    ]);
    assert.deepStrictEqual(planIssues(plan), []);
  });
});

describe("planIssues（手順の質の決まりごと）", () => {
  it("手順がないのは問題", () => {
    assert.deepStrictEqual(planIssues({ steps: [] }), ["empty"]);
  });

  it("手順の文に URL を書く・メールの操作を手作業にする・Web の手順に開く先がない・担当がない、を見つける", () => {
    const plan = planFromProposedSteps([
      // 開く先があると、文の URL は開く先に移らずに残る（採点で見つけたいもの）
      { title: "https://example.com/settings を開いて確かめる", effort: "easy", mode: "serial", type: "manual", actor: "human", link: { url: "https://example.com", label: "Example" } },
      { title: "請求メールにレシートラベルを付けてアーカイブする", effort: "easy", mode: "serial", type: "manual", actor: "human" },
      { title: "Search Console のレポートを開いて対象の URL を確認する", effort: "easy", mode: "serial", type: "manual", actor: "human" },
      { title: "返信する", effort: "easy", mode: "serial", type: "manual" },
    ]);
    assert.deepStrictEqual(planIssues(plan), ["url_in_title", "manual_mail_operation", "web_step_without_link", "no_actor"]);
  });

  it("分かれ道そのものに開く先がなくても、選んだあとの手順に開く先があれば問題なし", () => {
    const plan = planFromProposedSteps([
      {
        title: "権限更新の画面を見て承認するか決める",
        effort: "easy",
        mode: "serial",
        options: [{ label: "承認する", steps: [{ title: "画面で承認する", effort: "easy", mode: "serial", type: "manual", actor: "human", link: { url: "https://github.com/settings/installations", label: "GitHub" } }] }],
      },
    ]);
    assert.deepStrictEqual(planIssues(plan), []);
  });

  it("ボタンにできる操作をボタンの種類にし、開く先と担当を付けた手順は問題なし", () => {
    const plan = planFromProposedSteps([
      { title: "レシートラベルを付けてアーカイブする", effort: "easy", mode: "serial", type: "gmail_action", gmail: { labels: ["レシート"], markRead: true, archive: true } },
      { title: "Search Console のレポートを開いて確認する", effort: "easy", mode: "serial", type: "manual", actor: "human", link: { url: "https://search.google.com/search-console", label: "Search Console" } },
      { title: "経緯を調べてまとめる", effort: "normal", mode: "serial", type: "manual", actor: "claude_auto" },
    ]);
    assert.deepStrictEqual(planIssues(plan), []);
  });
});
