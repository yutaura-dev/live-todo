import { Effect, Schema } from "effect";

export class InvalidRepositoryPatternError extends Schema.TaggedError<InvalidRepositoryPatternError>()(
  "InvalidRepositoryPatternError",
  { pattern: Schema.String },
) {}

export type RepositoryFilterConfig = {
  include?: readonly string[];
  exclude?: readonly string[];
};

type Pattern = { owner: string; repo: string };

const RepositoryPattern = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+|\*)$/));
const isRepositoryPattern = Schema.is(RepositoryPattern);

const parsePattern = (pattern: string): Effect.Effect<Pattern, InvalidRepositoryPatternError> => {
  if (!isRepositoryPattern(pattern)) {
    return Effect.fail(new InvalidRepositoryPatternError({ pattern }));
  }
  const [owner = "", repo = ""] = pattern.toLowerCase().split("/");
  return Effect.succeed({ owner, repo });
};

export const makeRepositoryFilter = Effect.fnUntraced(function* (config: RepositoryFilterConfig) {
  const include = yield* Effect.forEach(config.include ?? [], parsePattern);
  const exclude = yield* Effect.forEach(config.exclude ?? [], parsePattern);

  return (fullName: string): boolean => {
    const [owner = "", repo = ""] = fullName.toLowerCase().split("/");
    const matchesAny = (patterns: readonly Pattern[]) =>
      patterns.some((pattern) => pattern.owner === owner && (pattern.repo === "*" || pattern.repo === repo));

    if (matchesAny(exclude)) return false;
    return include.length === 0 || matchesAny(include);
  };
});
