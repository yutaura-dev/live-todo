import { Effect, Option, Ref, Schema } from "effect";
import { DEFAULT_TODO_THRESHOLDS, type JudgeInput, makeTodoJudge, type TodoJudgeThresholds } from "../../core/judge/todo-judge.js";
import type { ItemDraft, SourceBinding } from "../../core/sync/sync-source.js";
import {
  BODY_EXCERPT_LENGTH,
  GitHubClient,
  type GitHubAdapterOptions,
  type GitHubItem,
  GitHubNotificationSchema,
  githubTodoRules,
  makeGitHubAdapter,
} from "./github-adapter.js";

/** アカウントごとに Source 名を分け、カーソルや Item が混ざらないようにする */
export const githubSourceName = (accountId: string) => `github:${accountId}`;

const GITHUB_TODO_QUESTION = "この GitHub の通知は、自分が対応すべきタスクか？";

const GitHubCursor = Schema.Struct({
  since: Schema.String,
  backfill: Schema.optionalKey(Schema.Struct({ before: Schema.String, newest: Schema.String })),
  retry: Schema.optionalKey(Schema.Array(Schema.Struct({ notification: GitHubNotificationSchema, firstFailedAt: Schema.String }))),
});

export type GitHubBindingOptions = GitHubAdapterOptions & { accountId: string; thresholds?: TodoJudgeThresholds };

export function githubItemDraft(item: GitHubItem): ItemDraft {
  return {
    // リポジトリ名を添える理由: 依存更新の PR のように、同じタイトルが複数のリポジトリに並ぶと見分けられないため。
    title: `${item.title}（${item.repository}）`,
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

const Viewer = Schema.Struct({ login: Schema.String });
const Comment = Schema.Struct({
  user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  body: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeViewer = Schema.decodeUnknownOption(Viewer);
const decodeComment = Schema.decodeUnknownOption(Comment);

type Context = { viewer: Option.Option<string>; comment: Option.Option<{ author: string; body: string }> };

// live-todo が書いた信頼できる情報と、外部から来た文字列（タイトル・本文・コメント）を分ける理由:
// 本文に「通知の理由: review_requested」のような行を書いて信頼できる行になりすますことを防ぐため。
function describeGitHubItem(item: GitHubItem, context: Context): JudgeInput {
  const trusted = [
    ...Option.match(context.viewer, { onNone: () => [], onSome: (login) => [`あなた（ユーザー本人）の GitHub アカウント: @${login}`] }),
    `種類: GitHub の ${item.subjectType}`,
    `リポジトリ: ${item.repository}`,
    `通知の理由: ${item.reason}`,
    ...(item.author === undefined ? [] : [`作成者: @${item.author}`]),
  ];
  const untrusted = [
    `タイトル: ${item.title}`,
    ...(item.bodyExcerpt === undefined ? [] : ["本文（冒頭）:", item.bodyExcerpt]),
    ...Option.match(context.comment, {
      onNone: () => [],
      onSome: ({ author, body }) => [`最新のコメント（@${author}）:`, body],
    }),
  ];
  return { context: trusted.join("\n"), input: untrusted.join("\n") };
}

export const makeGitHubBinding = Effect.fnUntraced(function* (options: GitHubBindingOptions) {
  const adapter = yield* makeGitHubAdapter(options);
  const client = yield* GitHubClient;

  // 成功したときだけ覚える理由: 一時的な失敗を覚えてしまうと、そのプロセスの間ずっと自分のアカウント名なしで
  // 判定することになるため。失敗したら次の判定でまた取りに行く。
  const viewerCache = yield* Ref.make(Option.none<string>());
  const viewer = Effect.gen(function* () {
    const cached = yield* Ref.get(viewerCache);
    if (Option.isSome(cached)) return cached;
    const fetched = yield* client.getViewer.pipe(
      Effect.map((raw) => Option.map(decodeViewer(raw), ({ login }) => login)),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
    if (Option.isSome(fetched)) yield* Ref.set(viewerCache, fetched);
    return fetched;
  });

  // コメントが取れなくても判定は止めない理由: コメントは判定の材料を増やすためのもので、取れなければ
  // コメントなしの説明文で判定すればよい。
  const latestComment = (url: string) =>
    client.getComment(url).pipe(
      Effect.map((raw) =>
        Option.flatMap(Option.flatMap(raw, decodeComment), (comment) =>
          comment.body == null || comment.body === ""
            ? Option.none()
            : Option.some({ author: comment.user?.login ?? "unknown", body: comment.body.slice(0, BODY_EXCERPT_LENGTH) }),
        ),
      ),
      Effect.catch((error) =>
        Effect.logWarning("最新のコメントを取得できないため、コメントなしで判定する").pipe(
          Effect.annotateLogs({ url, reason: error.message }),
          Effect.as(Option.none<{ author: string; body: string }>()),
        ),
      ),
    );

  const describe = (item: GitHubItem) =>
    Effect.gen(function* () {
      const comment = item.latestCommentUrl === undefined ? Option.none() : yield* latestComment(item.latestCommentUrl);
      return describeGitHubItem(item, { viewer: yield* viewer, comment });
    });
  const judge = yield* makeTodoJudge({
    rules: githubTodoRules,
    describe,
    question: GITHUB_TODO_QUESTION,
    thresholds: options.thresholds ?? DEFAULT_TODO_THRESHOLDS,
  });

  return {
    source: githubSourceName(options.accountId),
    adapter,
    cursorSchema: GitHubCursor,
    externalIdOf: (item: GitHubItem) => item.externalId,
    toItemDraft: githubItemDraft,
    judge,
  } satisfies SourceBinding<GitHubItem, typeof GitHubCursor.Type, unknown, unknown, unknown>;
});
