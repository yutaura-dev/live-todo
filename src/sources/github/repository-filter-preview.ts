import { Effect } from "effect";
import { explainRepositoryFilter, type FilterDecision, type RepositoryFilterConfig } from "./repository-filter.js";

export { explainRepositoryFilter } from "./repository-filter.js";

export type GitHubTarget =
  | { repository: string; kind: "repository" }
  | { repository: string; kind: "pull" | "issue" | "number"; number: number };

const NAME = "[A-Za-z0-9_.-]+";
const SHORT_FORM = new RegExp(`^(${NAME})/(${NAME})(?:#(\\d+))?$`);
const PATH_FORM = new RegExp(`^/(${NAME})/(${NAME})(?:/(pull|issues)/(\\d+))?(?:/.*)?$`);

/** 設定画面で入力された「owner/repo」「owner/repo#12」「github.com の URL」を、判定できる形にする */
export function parseGitHubTarget(input: string): GitHubTarget | undefined {
  const text = input.trim();
  const short = SHORT_FORM.exec(text);
  if (short) {
    const repository = `${short[1]}/${short[2]}`;
    return short[3] === undefined ? { repository, kind: "repository" } : { repository, kind: "number", number: Number(short[3]) };
  }
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (url.hostname !== "github.com") return undefined;
  const path = PATH_FORM.exec(url.pathname.replace(/\/$/, ""));
  if (!path) return undefined;
  const repository = `${path[1]}/${path[2]}`;
  if (path[3] === undefined) return { repository, kind: "repository" };
  return { repository, kind: path[3] === "pull" ? "pull" : "issue", number: Number(path[4]) };
}

export type RepositoryDecision = FilterDecision & { repository: string };

export type RepositoryFilterPreview = {
  included: RepositoryDecision[];
  excluded: RepositoryDecision[];
  /** どの候補にも一致しなかったパターン。打ち間違いや、もう使っていない指定に気づけるようにする */
  unusedPatterns: string[];
};

export const previewRepositoryFilter = Effect.fnUntraced(function* (
  config: RepositoryFilterConfig,
  candidates: ReadonlyArray<string>,
) {
  const explain = yield* explainRepositoryFilter(config);
  const unique = [...new Map(candidates.map((name) => [name.toLowerCase(), name.toLowerCase()])).values()].sort();
  const decisions = unique.map((repository): RepositoryDecision => ({ repository, ...explain(repository) }));

  const usedPatterns = new Set(
    decisions.flatMap(({ reason }) => (reason.kind === "included_by" || reason.kind === "excluded_by" ? [reason.pattern] : [])),
  );
  // exclude は include より先に見るので、include に一致した候補が exclude のパターンを「使った」かどうかは別に確かめる
  const excludeExplain = yield* explainRepositoryFilter({ exclude: config.exclude ?? [] });
  for (const repository of unique) {
    const decision = excludeExplain(repository);
    if (decision.reason.kind === "excluded_by") usedPatterns.add(decision.reason.pattern);
  }

  return {
    included: decisions.filter((decision) => decision.included),
    excluded: decisions.filter((decision) => !decision.included),
    unusedPatterns: [...(config.include ?? []), ...(config.exclude ?? [])].filter((pattern) => !usedPatterns.has(pattern)),
  } satisfies RepositoryFilterPreview;
});
