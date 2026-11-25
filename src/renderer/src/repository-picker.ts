export type RepositoryChoices = { owners: readonly string[]; repositories: readonly string[] };

const MAX_SUGGESTIONS = 50;
// 保存のときに main で同じ形を検証する（src/sources/github/repository-filter.ts の RepositoryPattern）。
// ここで import しない理由: renderer に effect の Schema を持ち込むと、画面のバンドルが大きくなるため
const PATTERN = /^[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+|\*)$/;

export const isRepositoryPattern = (text: string) => PATTERN.test(text);

/** 入力に合う候補。owner のまとめ（owner/*）を先に出し、一覧にない形の正しい入力もそのまま候補にする */
export function suggestPatterns(choices: RepositoryChoices, query: string, selected: readonly string[]): string[] {
  const needle = query.trim().toLowerCase();
  const taken = new Set(selected.map((pattern) => pattern.toLowerCase()));
  const candidates = [...choices.owners.map((owner) => `${owner}/*`), ...choices.repositories];
  const matches = candidates.filter((candidate) => candidate.includes(needle) && !taken.has(candidate));
  const typed = needle !== "" && isRepositoryPattern(needle) && !candidates.includes(needle) && !taken.has(needle) ? [needle] : [];
  return [...typed, ...matches].slice(0, MAX_SUGGESTIONS);
}
