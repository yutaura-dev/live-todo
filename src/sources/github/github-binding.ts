import { Effect, Schema } from "effect";
import { DEFAULT_TODO_THRESHOLDS, makeTodoJudge, type TodoJudgeThresholds } from "../../core/judge/todo-judge.js";
import type { ItemDraft, SourceBinding } from "../../core/sync/sync-source.js";
import { type GitHubAdapterOptions, type GitHubItem, githubTodoRules, makeGitHubAdapter } from "./github-adapter.js";

export const GITHUB_SOURCE = "github";

const GITHUB_TODO_QUESTION = "この GitHub の通知は、自分が対応すべきタスクか？";

const GitHubCursor = Schema.Struct({ since: Schema.String });

export type GitHubBindingOptions = GitHubAdapterOptions & { thresholds?: TodoJudgeThresholds };

export function githubItemDraft(item: GitHubItem): ItemDraft {
  return {
    title: item.title,
    url: item.htmlUrl,
    // CI の通知など状態を取れない（unknown）ものは open として扱う。解決の合図が取れないため、
    // 自動では done にならず、ユーザーが閉じる前提になる。
    state: item.state === "merged" || item.state === "closed" ? "resolved" : "open",
    // updated_at を含める理由: 新しいコメントやレビューなどの動きを Activity（changed）として残し、
    // あとで Task の brief を書き直す材料にするため。更新マークは Task の項目が変わったときだけ付くので、
    // ここに含めても目印が増えることはない（ADR-0007）。
    fingerprint: JSON.stringify([item.title, item.state, item.updatedAt]),
  };
}

function describeGitHubItem(item: GitHubItem): string {
  return [
    `種類: GitHub の ${item.subjectType}`,
    `リポジトリ: ${item.repository}`,
    `通知の理由: ${item.reason}`,
    `タイトル: ${item.title}`,
  ].join("\n");
}

export const makeGitHubBinding = Effect.fnUntraced(function* (options: GitHubBindingOptions) {
  const adapter = yield* makeGitHubAdapter(options);
  const judge = yield* makeTodoJudge({
    rules: githubTodoRules,
    describe: describeGitHubItem,
    question: GITHUB_TODO_QUESTION,
    thresholds: options.thresholds ?? DEFAULT_TODO_THRESHOLDS,
  });

  return {
    source: GITHUB_SOURCE,
    adapter,
    cursorSchema: GitHubCursor,
    externalIdOf: (item: GitHubItem) => item.externalId,
    toItemDraft: githubItemDraft,
    judge,
  } satisfies SourceBinding<GitHubItem, typeof GitHubCursor.Type, unknown, unknown, unknown>;
});
