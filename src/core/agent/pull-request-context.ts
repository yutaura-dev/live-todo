/** PR の情報を集める gh コマンドの引数。どれも読み取りだけ */
export function pullRequestCommands(pullUrl: string) {
  return {
    view: ["pr", "view", pullUrl, "--json", "title,body,author,files,statusCheckRollup,baseRefName,headRefName,mergeable"],
    diff: ["pr", "diff", pullUrl],
  };
}

// 差分を書き出す上限（文字数）。lockfile の差分は巨大になり、読ませても判断の材料にならないため
export const MAX_DIFF_LENGTH = 200_000;

export function truncateDiff(diff: string, max = MAX_DIFF_LENGTH): string {
  if (diff.length <= max) return diff;
  return `${diff.slice(0, max)}\n\n(差分が大きいため、ここで切った。残り ${diff.length - max} 文字)`;
}

/** 作業場所の中で、集めた PR の情報を置くフォルダ（claude はこのフォルダのファイルを読む） */
export const REVIEW_CONTEXT_DIR = ".live-todo-review";
