export type MergeMethod = "squash" | "merge" | "rebase";
export type AllowedMergeMethods = { allowSquashMerge: boolean; allowMergeCommit: boolean; allowRebaseMerge: boolean };
export type RecentCommit = { title: string; parents: number };

const SQUASH_TITLE = /\(#\d+\)$/;
const FALLBACK_ORDER: ReadonlyArray<MergeMethod> = ["squash", "merge", "rebase"];
const LABELS: Record<MergeMethod, string> = { squash: "squash", merge: "merge commit", rebase: "rebase" };

/**
 * リポジトリの慣習に合わせて merge の方法を選ぶ。最近の commit が merge commit（親が 2 つ）か、
 * squash（1 つ親でタイトルが「… (#番号)」）か、それ以外の 1 つ親（rebase）かを数え、多いものにする。
 */
export function chooseMergeMethod(allowed: AllowedMergeMethods, commits: ReadonlyArray<RecentCommit>): { method: MergeMethod; reason: string } {
  const isAllowed = (method: MergeMethod) =>
    method === "squash" ? allowed.allowSquashMerge : method === "merge" ? allowed.allowMergeCommit : allowed.allowRebaseMerge;
  const permitted = FALLBACK_ORDER.filter(isAllowed);
  if (permitted.length === 1) return { method: permitted[0]!, reason: `リポジトリで許されているのが ${LABELS[permitted[0]!]} だけ` };

  const counts: Record<MergeMethod, number> = { squash: 0, merge: 0, rebase: 0 };
  for (const commit of commits) {
    if (commit.parents >= 2) counts.merge++;
    else if (SQUASH_TITLE.test(commit.title)) counts.squash++;
    else counts.rebase++;
  }
  const usual = FALLBACK_ORDER.filter(isAllowed).toSorted((a, b) => counts[b] - counts[a])[0];
  if (commits.length > 0 && usual !== undefined && counts[usual] > 0) {
    return { method: usual, reason: `既定のブランチの最近の commit ${commits.length} 件中 ${counts[usual]} 件が ${LABELS[usual]}` };
  }
  const fallback = permitted[0] ?? "merge";
  return { method: fallback, reason: `最近の commit から慣習を読み取れなかったので、許されている方法から ${LABELS[fallback]} を選んだ` };
}
