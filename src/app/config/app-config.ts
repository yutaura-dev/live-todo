import { Effect, FileSystem, Schema } from "effect";
import { isRepositoryPattern } from "../../sources/github/repository-filter.js";

export class InvalidAppConfigError extends Schema.TaggedError<InvalidAppConfigError>()("InvalidAppConfigError", {
  message: Schema.String,
}) {}

// id を Source 名（"github:<id>:watch"）の一部に使うため、区切り文字の ":" や空白を含められないようにする。
const AccountId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/));

const LlmProfile = Schema.Struct({
  // none: LLM を使わない（規則で決まらないものはすべて要確認）。API キーがまだない環境でも動かせるようにするため。
  provider: Schema.Literals(["none", "anthropic", "openai", "gemini", "azure-openai", "bedrock"]),
  model: Schema.NonEmptyString,
  decisions: Schema.optional(
    Schema.Struct({
      provider: Schema.Literals(["jev", "openai", "gemini"]),
      model: Schema.optional(Schema.String),
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
});
export type GitHubAccount = typeof GitHubAccount.Type;

const AppConfigFile = Schema.Struct({
  llmProfiles: Schema.Record(Schema.String, LlmProfile),
  defaultLlmProfile: Schema.String,
  accounts: Schema.Array(GitHubAccount),
});

export type ResolvedAccount = GitHubAccount & { resolvedLlmProfile: LlmProfile };

export type AppConfig = Omit<typeof AppConfigFile.Type, "accounts"> & {
  accounts: ReadonlyArray<ResolvedAccount>;
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

  if (issues.length > 0) {
    return yield* new InvalidAppConfigError({ message: issues.join("\n") });
  }
  return { ...file, accounts };
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
