export type RepositoryFilterConfig = {
  include?: readonly string[];
  exclude?: readonly string[];
};

type Pattern = { owner: string; repo: string | "*" };

const NAME = /^[A-Za-z0-9_.-]+$/;

export function createRepositoryFilter(config: RepositoryFilterConfig): (fullName: string) => boolean {
  const include = (config.include ?? []).map(parsePattern);
  const exclude = (config.exclude ?? []).map(parsePattern);

  return (fullName) => {
    const [owner = "", repo = ""] = fullName.toLowerCase().split("/");
    const matchesAny = (patterns: Pattern[]) =>
      patterns.some((pattern) => pattern.owner === owner && (pattern.repo === "*" || pattern.repo === repo));

    if (matchesAny(exclude)) return false;
    return include.length === 0 || matchesAny(include);
  };
}

function parsePattern(pattern: string): Pattern {
  const parts = pattern.toLowerCase().split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || owner === undefined || repo === undefined || !NAME.test(owner) || !(repo === "*" || NAME.test(repo))) {
    throw new Error(`不正なリポジトリのパターンです: ${pattern}`);
  }
  return { owner, repo };
}
