import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  DEPENDENCY_REVIEW_JSON_SCHEMA,
  DEPENDENCY_REVIEW_TOOLS,
  decodeDependencyReview,
  dependencyReviewPrompt,
  isDependencyBot,
} from "./dependency-review.js";

const NONE = { kind: "none" as const, repository: "", query: "", pullUrl: "" };

describe("isDependencyBot", () => {
  it.each(["renovate[bot]", "dependabot[bot]", "renovate-bot", "app/renovate", "app/dependabot", "Renovate[bot]"])(
    "依存更新の bot と見なす: %s",
    (login) => {
      assert.isTrue(isDependencyBot(login));
    },
  );

  it.each(["octocat", "renovate-fan", "github-actions[bot]", undefined, null])("それ以外は対象にしない: %s", (login) => {
    assert.isFalse(isDependencyBot(login));
  });
});

describe("decodeDependencyReview", () => {
  const valid = {
    conclusion: "mergeable_after_fix",
    impact: "型定義の変更で 2 ファイルに影響",
    requiredChanges: "src/a.ts の呼び出しを新しい引数に合わせる",
    blockers: "",
    configChanges: "",
    canMergeAsIs: true,
    mergeAsIsNote: "fork からの PR を受け付けないなら、修正せずに merge してよい",
    fixEffort: "normal",
    nextActions: [{ title: "修正する", type: "fix_and_push", until: NONE, effort: "normal", mode: "serial", options: [] }],
  };

  it.effect("3 つの結論のどれかと、影響範囲・修正・理由・設定の直し方を受け取る", () =>
    Effect.gen(function* () {
      const review: unknown = yield* decodeDependencyReview(valid);
      assert.deepStrictEqual(review, valid);
    }));

  it.effect("そのまま merge してよいかの項目がない古い回答は、そのまま merge しない（false）として読む", () =>
    Effect.gen(function* () {
      const { canMergeAsIs: _omitted, mergeAsIsNote: _note, ...old } = valid;

      const review = yield* decodeDependencyReview(old);

      assert.isFalse(review.canMergeAsIs);
      assert.strictEqual(review.mergeAsIsNote, "");
    }));

  it.effect("知らない結論はエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeDependencyReview({ ...valid, conclusion: "maybe" }));
      assert.strictEqual(error._tag, "SchemaError");
    }));
});

describe("DEPENDENCY_REVIEW_JSON_SCHEMA", () => {
  it("claude に求める回答の項目が、受け取る形と一致する", () => {
    assert.deepStrictEqual(DEPENDENCY_REVIEW_JSON_SCHEMA.required, [
      "conclusion",
      "impact",
      "requiredChanges",
      "blockers",
      "configChanges",
      "canMergeAsIs",
      "mergeAsIsNote",
      "fixEffort",
      "nextActions",
    ]);
    assert.deepStrictEqual(DEPENDENCY_REVIEW_JSON_SCHEMA.properties.conclusion.enum, ["mergeable", "mergeable_after_fix", "not_mergeable"]);
  });
});

describe("dependencyReviewPrompt", () => {
  const prompt = dependencyReviewPrompt({
    url: "https://github.com/acme/app/pull/42",
    repository: "acme/app",
    title: "Update dependency effect to v4",
    contextDir: "/work/task-1/context",
  });

  it("対象の PR とリポジトリを伝える", () => {
    assert.include(prompt, "https://github.com/acme/app/pull/42");
    assert.include(prompt, "acme/app");
  });

  it("書き込みをしないよう伝える（ツールでも禁じているが、試みて止まるのを避ける）", () => {
    assert.include(prompt, "書き込み");
  });

  it("リポジトリで開いている PR と Dependency Dashboard を見て、待つべきか・先にやることがあるかを考えるよう伝える", () => {
    assert.include(prompt, "/work/task-1/context/open-prs.json");
    assert.include(prompt, "/work/task-1/context/dependency-dashboard.md");
  });

  it("待つ手順には、アプリが見張れるよう何を待つか（出るのを待つ PR の検索語など）を書かせる", () => {
    assert.include(prompt, "until");
    assert.include(prompt, "pull_request_opened");
  });

  it("先に要る更新の PR がまだなければ、今すぐ作らせるか schedule を待つかを選べる分かれ道にするよう伝える", () => {
    assert.include(prompt, "schedule");
    assert.include(prompt, "分かれ道");
  });

  it("アプリが集めておいた PR の情報（本文・CI・差分）を読むよう伝える", () => {
    assert.include(prompt, "/work/task-1/context/pr.json");
    assert.include(prompt, "/work/task-1/context/pr.diff");
  });
});

describe("DEPENDENCY_REVIEW_TOOLS", () => {
  it("ファイルの読み取りと検索だけを許す（Bash は読み取りだけのコマンドを確認なしで通すので、渡さない）", () => {
    assert.deepStrictEqual([...DEPENDENCY_REVIEW_TOOLS], ["Read", "Grep", "Glob"]);
  });

  it("読み取りだけを許す（ファイルの編集・任意のコマンド・GitHub API への送信は許さない）", () => {
    for (const tool of DEPENDENCY_REVIEW_TOOLS) {
      assert.notMatch(tool, /^(Edit|Write|NotebookEdit)$/);
      assert.notStrictEqual(tool, "Bash");
      assert.notInclude(tool, "gh api");
      assert.notStrictEqual(tool, "Bash(*)");
    }
    assert.includeMembers(DEPENDENCY_REVIEW_TOOLS as string[], ["Read", "Grep", "Glob"]);
  });
});
