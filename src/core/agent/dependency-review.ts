import { Schema } from "effect";

const DEPENDENCY_BOTS = new Set(["renovate[bot]", "renovate-bot", "app/renovate", "dependabot[bot]", "app/dependabot"]);

/** 依存更新の PR を作る bot か（renovate / dependabot） */
export const isDependencyBot = (login: string | null | undefined): boolean =>
  login !== null && login !== undefined && DEPENDENCY_BOTS.has(login.toLowerCase());

export const DEPENDENCY_REVIEW_CONCLUSIONS = ["mergeable", "mergeable_after_fix", "not_mergeable"] as const;

const DependencyReview = Schema.Struct({
  conclusion: Schema.Literals(DEPENDENCY_REVIEW_CONCLUSIONS),
  impact: Schema.String,
  requiredChanges: Schema.String,
  blockers: Schema.String,
  configChanges: Schema.String,
});
export type DependencyReview = typeof DependencyReview.Type;
export const decodeDependencyReview = Schema.decodeUnknownEffect(DependencyReview);

/** claude -p の --json-schema に渡す形。DependencyReview と項目をそろえる（テストで確かめている） */
export const DEPENDENCY_REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    conclusion: {
      type: "string",
      enum: [...DEPENDENCY_REVIEW_CONCLUSIONS],
      description: "mergeable: そのまま merge できる / mergeable_after_fix: 修正すれば merge できる / not_mergeable: merge できない",
    },
    impact: { type: "string", description: "影響範囲の調査結果。どのファイル・機能が影響を受けるか、なぜそう言えるか" },
    requiredChanges: { type: "string", description: "mergeable_after_fix のとき、具体的にどう直すか。それ以外は空文字" },
    blockers: { type: "string", description: "not_mergeable のとき、なぜ merge できないか。それ以外は空文字" },
    configChanges: {
      type: "string",
      description: "not_mergeable のとき、renovate / dependabot の設定ファイルをどう直せばよいか（ファイル名と差分）。それ以外は空文字",
    },
  },
  required: ["conclusion", "impact", "requiredChanges", "blockers", "configChanges"],
  additionalProperties: false,
} as const;

/**
 * 調査で使ってよいツール。読み取りだけにする（外部への書き込みは承認を経由させるという charter の制約のため）。
 * gh api は -X POST などで書き込めるので許さない。Bash の許可はコマンド名ごとに絞る。
 */
export const DEPENDENCY_REVIEW_TOOLS: ReadonlyArray<string> = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr checks:*)",
  "Bash(gh release view:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
];

export function dependencyReviewPrompt(subject: { url: string; repository: string; title: string }): string {
  return [
    "依存関係を更新する bot の PR を調べ、merge してよいかを判断してください。",
    "",
    `PR: ${subject.url}`,
    `リポジトリ: ${subject.repository}（作業ディレクトリに既定のブランチを clone してあります）`,
    `タイトル: ${subject.title}`,
    "",
    "調べ方:",
    "- gh pr view / gh pr diff / gh pr checks で、更新内容と CI の結果を確かめる",
    "- 更新するパッケージの変更履歴（リリースノート・CHANGELOG）で、破壊的変更を確かめる",
    "- 作業ディレクトリのコードを Grep / Read して、そのパッケージを使っている箇所と影響を確かめる",
    "",
    "答えること:",
    "- 結論: mergeable（そのまま merge できる）/ mergeable_after_fix（修正すれば merge できる）/ not_mergeable（merge できない）",
    "- 影響範囲の調査結果（どこに影響があり、なぜそう判断したか）",
    "- 修正が必要なら、具体的にどこをどう直すか",
    "- merge できないなら、その理由と、renovate / dependabot の設定ファイルをどう直せばよいか",
    "",
    "書き込みはしないでください（コメント・承認・push・ファイルの編集など）。調べて答えるだけにしてください。",
    "日本語で、根拠となるファイル名やリリースノートの記述を添えて答えてください。",
  ].join("\n");
}
