import { Option, Schema } from "effect";

const HeadSha = Schema.fromJsonString(Schema.Struct({ headRefOid: Schema.String }));
const decodeHeadSha = Schema.decodeUnknownOption(HeadSha);

/** gh pr view の JSON から、調べたときの head の commit を読む */
export const headShaOf = (viewJson: string): string | undefined =>
  Option.getOrUndefined(Option.map(decodeHeadSha(viewJson), (view) => view.headRefOid));

/** PR の情報を集める gh コマンドの引数。どれも読み取りだけ */
export function pullRequestCommands(pullUrl: string) {
  const repository = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(pullUrl)?.[1] ?? "";
  return {
    // 先に要る別の依存の更新がもう PR になっているかを、AI が確かめられるようにする
    openPulls: ["pr", "list", "--repo", repository, "--state", "open", "--json", "number,title,author,url,headRefName", "--limit", "100"],
    // schedule で止まっている更新が載る。今すぐ作らせる手順を考えるため
    dashboard: ["issue", "list", "--repo", repository, "--state", "open", "--search", "Dependency Dashboard in:title", "--json", "number,title,body,url", "--limit", "1"],
    view: ["pr", "view", pullUrl, "--json", "title,body,author,files,statusCheckRollup,baseRefName,headRefName,headRefOid,mergeable"],
    diff: ["pr", "diff", pullUrl],
    // 差分を取ったあとに head の commit を確かめ直すため（情報と差分の間に commit が足されていないか）
    head: ["pr", "view", pullUrl, "--json", "headRefOid"],
  };
}

// 差分を書き出す上限（文字数）。lockfile の差分は巨大になり、読ませても判断の材料にならないため
export const MAX_DIFF_LENGTH = 200_000;

export function truncateDiff(diff: string, max = MAX_DIFF_LENGTH): string {
  if (diff.length <= max) return diff;
  return `${diff.slice(0, max)}\n\n(差分が大きいため、ここで切った。残り ${diff.length - max} 文字)`;
}
