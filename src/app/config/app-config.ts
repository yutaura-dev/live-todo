import { Effect, FileSystem, Option, Schema } from "effect";
import { isRepositoryPattern } from "../../sources/github/repository-filter.js";
import { MAIL_TOPICS } from "../../core/judge/mail-classifier.js";

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

const GmailRule = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  createdAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/)),
  when: Schema.Struct({
    topics: Schema.optional(Schema.Array(Schema.Literals(MAIL_TOPICS))),
    kinds: Schema.optional(Schema.Array(Schema.Literals(["personal", "notification", "newsletter"]))),
    fromContains: Schema.optional(Schema.String),
    subjectContains: Schema.optional(Schema.String),
  }).pipe(Schema.annotate({ parseOptions: { onExcessProperty: "error" } })),
  // 操作はラベルの付け外しだけ（ADR-0014）。決めていない操作（ゴミ箱に入れるなど）は書けないようにする
  then: Schema.Struct({
    labels: Schema.optional(Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(100)))),
    markRead: Schema.optional(Schema.Boolean),
    archive: Schema.optional(Schema.Boolean),
  }).pipe(Schema.annotate({ parseOptions: { onExcessProperty: "error" } })),
});

const GmailAccount = Schema.Struct({
  kind: Schema.Literal("gmail"),
  id: AccountId,
  llmProfile: Schema.optional(Schema.String),
  // 利用者が決めたルール。設定したルールの範囲の書き込みは、設定したことを承認とみなして自動で行う（ADR-0014）
  rules: Schema.Array(GmailRule).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
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
});

export type ResolvedAccount = GitHubAccount & { resolvedLlmProfile: LlmProfile };

export type ResolvedSlackAccount = SlackAccount & { resolvedLlmProfile: LlmProfile };

export type ResolvedGmailAccount = GmailAccount & { resolvedLlmProfile: LlmProfile };

export type AppConfig = Omit<typeof AppConfigFile.Type, "accounts" | "slackAccounts" | "gmailAccounts"> & {
  accounts: ReadonlyArray<ResolvedAccount>;
  slackAccounts: ReadonlyArray<ResolvedSlackAccount>;
  gmailAccounts: ReadonlyArray<ResolvedGmailAccount>;
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
    account.rules.forEach((rule, at) => {
      const { topics, kinds, fromContains, subjectContains } = rule.when;
      if ((topics ?? []).length === 0 && (kinds ?? []).length === 0 && (fromContains ?? "").trim() === "" && (subjectContains ?? "").trim() === "") {
        issues.push(`gmailAccounts[${index}].rules[${at}]（${rule.name}）: 条件を 1 つ以上決めてください`);
      }
      if ((rule.then.labels ?? []).length === 0 && rule.then.markRead !== true && rule.then.archive !== true) {
        issues.push(`gmailAccounts[${index}].rules[${at}]（${rule.name}）: 操作を 1 つ以上決めてください`);
      }
    });
    if (resolvedLlmProfile.decisions === undefined) {
      issues.push(`gmailAccounts[${index}]: メールの仕分けに Decisions を使うので、LLM Profile「${profileName}」に decisions を書いてください`);
      return;
    }
    gmailAccounts.push({ ...account, resolvedLlmProfile });
  });

  if (issues.length > 0) {
    return yield* new InvalidAppConfigError({ message: issues.join("\n") });
  }
  return { ...file, accounts, slackAccounts, gmailAccounts };
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
