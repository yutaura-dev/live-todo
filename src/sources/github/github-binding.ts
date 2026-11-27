import { Effect, Option, Ref, Schema } from "effect";
import { DEFAULT_TODO_THRESHOLDS, type JudgeInput, makeTodoJudge, type TodoJudgeThresholds } from "../../core/judge/todo-judge.js";
import type { ItemFact } from "../../core/source/source-item.js";
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

// 「自分」ではなく「アカウントの持ち主（ユーザー本人）」と書く理由: Decisions の確率がどの通知でも 0.1〜0.2 程度に
// そろって低く出た。前置きのない Decisions では「自分」を判定する側と読まれている可能性があったため。
const GITHUB_TODO_QUESTION =
  "信頼できる情報にある GitHub アカウントの持ち主（ユーザー本人）が、この通知の件で返信・レビュー・作業・判断などの対応をする必要があるか？";

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
    // updated_at を含める理由: コメントやレビューの動きを Activity（changed）として残し、brief を書き直す材料にするため。
    // 更新マークは Task の項目の変化にだけ付くので、目印は増えない（ADR-0007）。
    fingerprint: JSON.stringify([item.title, item.state, item.updatedAt]),
    ...(item.author === undefined ? {} : { author: item.author }),
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
  return { context: withOwnershipNote(trusted.join("\n")), input: untrusted.join("\n") };
}

type FactContext = { viewer: Option.Option<string>; myTeams: Option.Option<ReadonlySet<string>> };

/** 自分（または所属チーム）へのレビュー依頼。自分に関わる結論はアプリが決めて 1 行で書く（ADR-0019 の spike） */
function reviewRequestLines(item: GitHubItem, context: FactContext): string[] {
  if (item.requestedReviewers === undefined && item.requestedTeams === undefined) return [];
  const reviewers = item.requestedReviewers ?? [];
  const teams = item.requestedTeams ?? [];
  const viewer = Option.getOrUndefined(context.viewer);
  const toMe = [
    ...(viewer !== undefined && reviewers.includes(viewer) ? ["あなた個人"] : []),
    ...Option.match(context.myTeams, { onNone: () => [], onSome: (mine) => teams.filter((team) => mine.has(team)).map((team) => `チーム @${team}`) }),
  ];
  const others = reviewers.filter((login) => login !== viewer).length + Option.match(context.myTeams, { onNone: () => teams.length, onSome: (mine) => teams.filter((team) => !mine.has(team)).length });
  // 所属チームが分からないままチームにだけ依頼が来ているなら、依頼なしと決めつけない（ルールで誤って完了にしないため）
  const unknown = toMe.length === 0 && teams.length > 0 && Option.isNone(context.myTeams);
  return [
    `あなた（または所属チーム）へのレビュー依頼: ${unknown ? "不明（所属チームを取得できない）" : toMe.length === 0 ? "なし" : `あり（${toMe.join("、")}）`}`,
    `ほかの人・チームへのレビュー依頼: ${others === 0 ? "なし" : `${others} 件`}`,
  ];
}

function stateLine(item: GitHubItem): string[] {
  if (item.subjectType === "PullRequest") {
    return [`PR の状態: ${item.state === "merged" ? "マージ済み" : item.state === "closed" ? "マージされずに閉じた" : item.state === "open" ? "open" : "不明"}`];
  }
  if (item.subjectType === "Issue") return [`Issue の状態: ${item.state === "closed" ? "閉じた" : item.state === "open" ? "open" : "不明"}`];
  return [];
}

/**
 * Item が表す事実（ADR-0019）。値がなくても「なし」と書き、状態は Source の言葉で書く。
 * どちらも、書かれていないことや粗い状態から判定のモデルが読み違えたため（spike）
 */
export function githubFactOf(item: GitHubItem, context: FactContext): ItemFact {
  return {
    trusted: [
      ...Option.match(context.viewer, { onNone: () => [], onSome: (login) => [`あなた（ユーザー本人）の GitHub アカウント: @${login}`] }),
      `種類: GitHub の ${item.subjectType}`,
      `リポジトリ: ${item.repository}`,
      `通知の理由: ${item.reason}`,
      ...(item.author === undefined ? [] : [`作成者: @${item.author}`]),
      ...reviewRequestLines(item, context),
      ...stateLine(item),
    ],
    body: [`タイトル: ${item.title}`, ...(item.bodyExcerpt === undefined ? [] : ["本文（冒頭）:", item.bodyExcerpt])].join("\n"),
  };
}

/**
 * 自分のアカウントで作った PR なら、本人が merge まで進める PR だと信頼できる情報に書き足す。
 * 足す理由: 理由が author の通知は対応が要るかを決めきれず、judge:eval で 6 件中 5 件が要確認になっていた。
 * 保存してある判定の入力にも当てられるよう、信頼できる情報の文から決める
 */
export function withOwnershipNote(trusted: string): string {
  const viewer = /^あなた（ユーザー本人）の GitHub アカウント: @(\S+)$/m.exec(trusted)?.[1];
  const author = /^作成者: @(\S+)$/m.exec(trusted)?.[1];
  if (viewer === undefined || viewer !== author || !/^種類: GitHub の PullRequest$/m.test(trusted)) return trusted;
  return `${trusted}\nこれはユーザー本人が作った PR。merge するか閉じるまで、レビューや CI・コメントへの対応は本人の作業として残る`;
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

  // コメントが取れなくても判定は止めない。コメントは判定の材料を増やすためだけのもの
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

  // 所属チームも、成功したときだけ覚える（取れないままのときは「不明」と書き、次の事実でまた取りに行く）
  const myTeamsCache = yield* Ref.make(Option.none<ReadonlySet<string>>());
  const myTeams = Effect.gen(function* () {
    const cached = yield* Ref.get(myTeamsCache);
    if (Option.isSome(cached)) return cached;
    const fetched = yield* client.listMyTeams.pipe(
      Effect.map((teams) => Option.some<ReadonlySet<string>>(new Set(teams))),
      Effect.catch((error) =>
        Effect.logWarning("所属チームを取得できないため、チームへのレビュー依頼を不明として書く").pipe(
          Effect.annotateLogs({ reason: error.message }),
          Effect.as(Option.none<ReadonlySet<string>>()),
        ),
      ),
    );
    if (Option.isSome(fetched)) yield* Ref.set(myTeamsCache, fetched);
    return fetched;
  });
  const describeFact = (item: GitHubItem) =>
    Effect.gen(function* () {
      return githubFactOf(item, { viewer: yield* viewer, myTeams: yield* myTeams });
    });

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
    describeFact,
  } satisfies SourceBinding<GitHubItem, typeof GitHubCursor.Type, unknown, unknown, unknown>;
});
