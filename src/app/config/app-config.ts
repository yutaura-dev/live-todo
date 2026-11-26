import { Effect, FileSystem, Option, Schema } from "effect";
import { isRepositoryPattern } from "../../sources/github/repository-filter.js";
import { NOTION_ORIGINS } from "../../sources/notion/notion-client-live.js";

export class InvalidAppConfigError extends Schema.TaggedError<InvalidAppConfigError>()("InvalidAppConfigError", {
  message: Schema.String,
}) {}

// id を Source 名（"github:<id>:watch"）の一部に使うため、区切り文字の ":" や空白を含められないようにする。
const AccountId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/));

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

const LlmProfile = Schema.Struct({
  // none: LLM を使わない（規則で決まらないものはすべて要確認）。API キーがまだない環境でも動かせるようにするため。
  provider: Schema.Literals(["none", "anthropic", "openai", "gemini", "azure-openai", "bedrock"]),
  model: Schema.NonEmptyString,
  decisions: Schema.optional(
    Schema.Struct({
      provider: Schema.Literals(["jev", "openai", "gemini"]),
      model: Schema.optional(Schema.String),
      thresholds: Schema.optional(Schema.Struct({ todo: Probability, review: Probability })),
    }),
  ),
});
export type LlmProfile = typeof LlmProfile.Type;

const RepositoryFilter = Schema.Struct({
  include: Schema.optional(Schema.Array(Schema.String)),
  exclude: Schema.optional(Schema.Array(Schema.String)),
});

const GitHubAccount = Schema.Struct({
  kind: Schema.Literal("github"),
  id: AccountId,
  llmProfile: Schema.optional(Schema.String),
  initialLookbackDays: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(14))),
  repositories: Schema.optional(RepositoryFilter),
  // 既定で調べない理由: claude -p は Claude（Anthropic）にコードと PR を送る。会社のアカウントのデータを
  // 許可していない LLM に送らないよう（charter の前提と制約）、アカウントごとに明示して有効にする
  reviewDependencyPrs: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  // 次にやることを Claude Code に考えさせるか。Task の内容（通知の本文の抜粋など）を Claude に送るので、同じ理由で既定はオフ
  planNextActions: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type GitHubAccount = typeof GitHubAccount.Type;

const SlackAccount = Schema.Struct({
  kind: Schema.Literal("slack"),
  id: AccountId,
  workspace: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*(\.enterprise)?\.slack\.com$/)),
  // セッションを取ったブラウザの User-Agent。違うと全端末のログアウトを招くことがあるので、アプリで作らずに書いてもらう（ADR-0010）
  userAgent: Schema.NonEmptyString,
  llmProfile: Schema.optional(Schema.String),
  planNextActions: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type SlackAccount = typeof SlackAccount.Type;

const NotionAccount = Schema.Struct({
  kind: Schema.Literal("notion"),
  id: AccountId,
  // セッションの持ち主。Cookie の notion_user_id とヘッダに入れる（ADR-0015）
  userId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
  // セッションを取ったブラウザの User-Agent。ログインと同期で同じ値を使う
  userAgent: Schema.NonEmptyString,
  // notion.so から notion.com への移行中で、ログインしたドメインによって API の接続先が違う
  origin: Schema.Literals(NOTION_ORIGINS).pipe(Schema.withDecodingDefaultKey(Effect.succeed("https://www.notion.so" as const))),
  llmProfile: Schema.optional(Schema.String),
});
export type NotionAccount = typeof NotionAccount.Type;

/** 利用者が決めたルール（ADR-0014）。条件は言葉で書き、操作は Source ごとに持つ（今は Gmail のラベル・既読・アーカイブだけ） */
const Rule = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  createdAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/)),
  when: Schema.String.check(Schema.isMaxLength(500)),
  then: Schema.String.check(Schema.isMaxLength(500)),
  interpretedFrom: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  // then から読み取った操作。決めたものだけ書ける（ゴミ箱に入れる・送るなどは書けない）
  actions: Schema.Struct({
    gmail: Schema.optional(
      Schema.Struct({
        labels: Schema.optional(Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(100)))),
        markRead: Schema.optional(Schema.Boolean),
        archive: Schema.optional(Schema.Boolean),
      }).pipe(Schema.annotate({ parseOptions: { onExcessProperty: "error" } })),
    ),
  }).pipe(Schema.annotate({ parseOptions: { onExcessProperty: "error" } })),
});

const GmailAccount = Schema.Struct({
  kind: Schema.Literal("gmail"),
  id: AccountId,
  llmProfile: Schema.optional(Schema.String),
  // 人からのメールを Claude Code に読ませて Task にするか。本文を Claude に送るので、ほかの Source と同じく既定はオフ
  planNextActions: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type GmailAccount = typeof GmailAccount.Type;

const AppConfigFile = Schema.Struct({
  llmProfiles: Schema.Record(Schema.String, LlmProfile),
  defaultLlmProfile: Schema.String,
  accounts: Schema.Array(GitHubAccount),
  // GitHub の accounts と分ける理由: GitHub だけの項目（リポジトリのフィルタ・依存更新の調査）を読む箇所を、種類で分けずに済ませるため
  slackAccounts: Schema.Array(SlackAccount).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  gmailAccounts: Schema.Array(GmailAccount).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  notionAccounts: Schema.Array(NotionAccount).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // 利用者が決めたルール。決めたルールの範囲の書き込みは、決めたことを承認とみなして自動で行う（ADR-0014）
  rules: Schema.Array(Rule).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});

export type ResolvedAccount = GitHubAccount & { resolvedLlmProfile: LlmProfile };

export type ResolvedSlackAccount = SlackAccount & { resolvedLlmProfile: LlmProfile };

export type ResolvedGmailAccount = GmailAccount & { resolvedLlmProfile: LlmProfile };

export type ResolvedNotionAccount = NotionAccount & { resolvedLlmProfile: LlmProfile };

export type AppConfig = Omit<typeof AppConfigFile.Type, "accounts" | "slackAccounts" | "gmailAccounts" | "notionAccounts"> & {
  accounts: ReadonlyArray<ResolvedAccount>;
  slackAccounts: ReadonlyArray<ResolvedSlackAccount>;
  gmailAccounts: ReadonlyArray<ResolvedGmailAccount>;
  notionAccounts: ReadonlyArray<ResolvedNotionAccount>;
};

const decodeFile = Schema.decodeUnknownEffect(AppConfigFile);
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const decodeAppConfig = Effect.fnUntraced(function* (input: unknown): Effect.fn.Return<AppConfig, InvalidAppConfigError> {
  const file = yield* decodeFile(input).pipe(Effect.mapError((error) => new InvalidAppConfigError({ message: error.message })));

  // 項目同士の整合性を Schema の外で検証する理由: 1 項目だけを見ても判定できない（別の項目を参照している）ため。
  // 問題を 1 つずつではなくまとめて返し、設定を直す往復を減らす。
  const issues: string[] = [];
  const profileOf = (name: string) => file.llmProfiles[name];

  if (profileOf(file.defaultLlmProfile) === undefined) {
    issues.push(`defaultLlmProfile: "${file.defaultLlmProfile}" は llmProfiles にない`);
  }

  const seenIds = new Set<string>();
  const accounts: ResolvedAccount[] = [];
  file.accounts.forEach((account, index) => {
    if (seenIds.has(account.id)) issues.push(`accounts[${index}].id: "${account.id}" が重複している`);
    seenIds.add(account.id);

    for (const pattern of [...(account.repositories?.include ?? []), ...(account.repositories?.exclude ?? [])]) {
      if (!isRepositoryPattern(pattern)) {
        issues.push(`accounts[${index}].repositories: "${pattern}" は owner/repo か owner/* の形ではない`);
      }
    }

    const profileName = account.llmProfile ?? file.defaultLlmProfile;
    const resolvedLlmProfile = profileOf(profileName);
    if (resolvedLlmProfile === undefined) {
      if (account.llmProfile !== undefined) {
        issues.push(`accounts[${index}].llmProfile: "${account.llmProfile}" は llmProfiles にない`);
      }
      return;
    }
    accounts.push({ ...account, resolvedLlmProfile });
  });

  const slackAccounts: ResolvedSlackAccount[] = [];
  file.slackAccounts.forEach((account, index) => {
    if (seenIds.has(account.id)) issues.push(`slackAccounts[${index}].id: "${account.id}" が重複している`);
    seenIds.add(account.id);
    const resolvedLlmProfile = profileOf(account.llmProfile ?? file.defaultLlmProfile);
    if (resolvedLlmProfile === undefined) {
      if (account.llmProfile !== undefined) issues.push(`slackAccounts[${index}].llmProfile: "${account.llmProfile}" は llmProfiles にない`);
      return;
    }
    slackAccounts.push({ ...account, resolvedLlmProfile });
  });

  const gmailAccounts: ResolvedGmailAccount[] = [];
  file.gmailAccounts.forEach((account, index) => {
    if (seenIds.has(account.id)) issues.push(`gmailAccounts[${index}].id: "${account.id}" が重複している`);
    seenIds.add(account.id);
    const profileName = account.llmProfile ?? file.defaultLlmProfile;
    const resolvedLlmProfile = profileOf(profileName);
    if (resolvedLlmProfile === undefined) {
      if (account.llmProfile !== undefined) issues.push(`gmailAccounts[${index}].llmProfile: "${account.llmProfile}" は llmProfiles にない`);
      return;
    }
    if (resolvedLlmProfile.decisions === undefined) {
      issues.push(`gmailAccounts[${index}]: メールの仕分けに Decisions を使うので、LLM Profile「${profileName}」に decisions を書いてください`);
      return;
    }
    gmailAccounts.push({ ...account, resolvedLlmProfile });
  });

  const notionAccounts: ResolvedNotionAccount[] = [];
  file.notionAccounts.forEach((account, index) => {
    if (seenIds.has(account.id)) issues.push(`notionAccounts[${index}].id: "${account.id}" が重複している`);
    seenIds.add(account.id);
    const resolvedLlmProfile = profileOf(account.llmProfile ?? file.defaultLlmProfile);
    if (resolvedLlmProfile === undefined) {
      if (account.llmProfile !== undefined) issues.push(`notionAccounts[${index}].llmProfile: "${account.llmProfile}" は llmProfiles にない`);
      return;
    }
    notionAccounts.push({ ...account, resolvedLlmProfile });
  });

  file.rules.forEach((rule, at) => {
    if (rule.when.trim() === "") issues.push(`rules[${at}]（${rule.name}）: 「どういう時」を書いてください`);
    if (rule.then.trim() === "") issues.push(`rules[${at}]（${rule.name}）: 「何をする」を書いてください`);
    else if (rule.interpretedFrom !== rule.then) issues.push(`rules[${at}]（${rule.name}）: 「何をする」を書き換えたので、読み取り直してください`);
    const gmail = rule.actions.gmail;
    if (rule.then.trim() !== "" && (gmail === undefined || ((gmail.labels ?? []).length === 0 && gmail.markRead !== true && gmail.archive !== true))) {
      issues.push(`rules[${at}]（${rule.name}）: 「何をする」から操作を読み取れていません`);
    }
  });

  if (issues.length > 0) {
    return yield* new InvalidAppConfigError({ message: issues.join("\n") });
  }
  return { ...file, accounts, slackAccounts, gmailAccounts, notionAccounts };
});

/** 設定画面に出すための、検証前の設定。ファイルがなければ none */
export const readAppConfigDocument = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const missing = (error: { message: string }) => new InvalidAppConfigError({ message: `設定ファイルを読めない: ${path}: ${error.message}` });
  if (!(yield* fs.exists(path).pipe(Effect.mapError(missing)))) return Option.none<unknown>();
  const text = yield* fs.readFileString(path).pipe(Effect.mapError(missing));
  const json = yield* parseJson(text).pipe(
    Effect.mapError((error) => new InvalidAppConfigError({ message: `設定ファイルが JSON として読めない: ${path}: ${error.message}` })),
  );
  return Option.some(json);
});

/** 検証に通った設定だけを書く。一時ファイルから置き換えるので、書いている途中で落ちても前の設定が残る */
export const saveAppConfigFile = Effect.fnUntraced(function* (path: string, input: unknown) {
  yield* decodeAppConfig(input);
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${path}.tmp`;
  yield* fs.writeFileString(temporary, `${JSON.stringify(input, null, 2)}\n`).pipe(
    Effect.flatMap(() => fs.rename(temporary, path)),
    Effect.mapError((error) => new InvalidAppConfigError({ message: `設定ファイルを書けない: ${path}: ${error.message}` })),
  );
});

export const loadAppConfigFile = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError((error) => new InvalidAppConfigError({ message: `設定ファイルを読めない: ${path}: ${error.message}` })));
  const json = yield* parseJson(text).pipe(
    Effect.mapError((error) => new InvalidAppConfigError({ message: `設定ファイルが JSON として読めない: ${path}: ${error.message}` })),
  );
  return yield* decodeAppConfig(json);
});
