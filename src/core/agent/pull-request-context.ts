import { Option, Schema } from "effect";

const HeadSha = Schema.fromJsonString(Schema.Struct({ headRefOid: Schema.String }));
const decodeHeadSha = Schema.decodeUnknownOption(HeadSha);

/** gh pr view の JSON から、調べたときの head の commit を読む */
export const headShaOf = (viewJson: string): string | undefined =>
  Option.getOrUndefined(Option.map(decodeHeadSha(viewJson), (view) => view.headRefOid));

/** PR の情報を集める gh コマンドの引数。どれも読み取りだけ */
export function pullRequestCommands(pullUrl: string) {
  return {
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
