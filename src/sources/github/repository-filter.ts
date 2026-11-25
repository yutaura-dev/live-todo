import { Effect, Schema } from "effect";

export class InvalidRepositoryPatternError extends Schema.TaggedError<InvalidRepositoryPatternError>()(
  "InvalidRepositoryPatternError",
  { pattern: Schema.String },
) {}

export type RepositoryFilterConfig = {
  include?: readonly string[] | undefined;
  exclude?: readonly string[] | undefined;
};

type Pattern = { owner: string; repo: string };

const RepositoryPattern = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+|\*)$/));
export const isRepositoryPattern = Schema.is(RepositoryPattern);

const parsePattern = (pattern: string): Effect.Effect<Pattern, InvalidRepositoryPatternError> => {
  if (!isRepositoryPattern(pattern)) {
    return Effect.fail(new InvalidRepositoryPatternError({ pattern }));
  }
  const [owner = "", repo = ""] = pattern.toLowerCase().split("/");
  return Effect.succeed({ owner, repo });
};

export type FilterReason =
  | { kind: "no_filter" }
  | { kind: "included_by"; pattern: string }
  | { kind: "not_in_include" }
  | { kind: "excluded_by"; pattern: string }
  | { kind: "not_excluded" };

export type FilterDecision = { included: boolean; reason: FilterReason };

/** 同期で使う判定と、設定画面のプレビューで見せる理由を 1 か所で決める（両者がずれないように） */
export const explainRepositoryFilter = Effect.fnUntraced(function* (config: RepositoryFilterConfig) {
  const parse = (pattern: string) => Effect.map(parsePattern(pattern), (parsed) => ({ ...parsed, source: pattern }));
  const include = yield* Effect.forEach(config.include ?? [], parse);
  const exclude = yield* Effect.forEach(config.exclude ?? [], parse);

  return (fullName: string): FilterDecision => {
    const [owner = "", repo = ""] = fullName.toLowerCase().split("/");
    const firstMatch = (patterns: ReadonlyArray<Pattern & { source: string }>) =>
      patterns.find((pattern) => pattern.owner === owner && (pattern.repo === "*" || pattern.repo === repo));

    const excludedBy = firstMatch(exclude);
    if (excludedBy !== undefined) return { included: false, reason: { kind: "excluded_by", pattern: excludedBy.source } };
    if (include.length === 0) return { included: true, reason: exclude.length === 0 ? { kind: "no_filter" } : { kind: "not_excluded" } };
    const includedBy = firstMatch(include);
    return includedBy === undefined
      ? { included: false, reason: { kind: "not_in_include" } }
      : { included: true, reason: { kind: "included_by", pattern: includedBy.source } };
  };
});

export const makeRepositoryFilter = Effect.fnUntraced(function* (config: RepositoryFilterConfig) {
  const explain = yield* explainRepositoryFilter(config);
  return (fullName: string): boolean => explain(fullName).included;
});
