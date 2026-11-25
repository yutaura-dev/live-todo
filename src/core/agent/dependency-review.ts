import { Effect, Schema } from "effect";

export const DEPENDENCY_BOT_LOGINS = ["renovate[bot]", "renovate-bot", "app/renovate", "dependabot[bot]", "app/dependabot"] as const;
const DEPENDENCY_BOTS = new Set<string>(DEPENDENCY_BOT_LOGINS);

/** 依存更新の PR を作る bot か（renovate / dependabot） */
export const isDependencyBot = (login: string | null | undefined): boolean =>
  login !== null && login !== undefined && DEPENDENCY_BOTS.has(login.toLowerCase());

const ReviewStepFields = {
  title: Schema.NonEmptyString,
  type: Schema.Literals(["manual", "wait", "merge_pull_request", "fix_and_push"]),
  effort: Schema.Literals(["easy", "normal", "hard", "tedious"]),
  mode: Schema.Literals(["serial", "parallel"]),
};
const ReviewStep = Schema.Struct({
  ...ReviewStepFields,
  options: Schema.Array(Schema.Struct({ label: Schema.NonEmptyString, steps: Schema.Array(Schema.Struct(ReviewStepFields)) })),
});

export const DEPENDENCY_REVIEW_CONCLUSIONS = ["mergeable", "mergeable_after_fix", "not_mergeable"] as const;

const DependencyReview = Schema.Struct({
  conclusion: Schema.Literals(DEPENDENCY_REVIEW_CONCLUSIONS),
  impact: Schema.String,
  requiredChanges: Schema.String,
  blockers: Schema.String,
  configChanges: Schema.String,
  // この 2 つは後から足した項目。足す前の回答は「そのまま merge しない」として読む
  canMergeAsIs: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  mergeAsIsNote: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  fixEffort: Schema.Literals(["easy", "normal", "hard", "tedious"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("normal" as const))),
  nextActions: Schema.Array(ReviewStep).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type DependencyReview = typeof DependencyReview.Type;
export const decodeDependencyReview = Schema.decodeUnknownEffect(DependencyReview);

const REVIEW_STEP_PROPERTIES = {
  title: { type: "string", description: "やること（動詞で終わる短い文）" },
  type: {
    type: "string",
    enum: ["manual", "wait", "merge_pull_request", "fix_and_push"],
    description:
      "manual: 自分が手を動かす / wait: 自分では進められず待つ（依存先の PR が出るのを待つなど）/ merge_pull_request: この PR を merge する / fix_and_push: 修正してこの PR に push する",
  },
  effort: {
    type: "string",
    enum: ["easy", "normal", "hard", "tedious"],
    description: "手間。easy: 10 秒で終わる / normal: 5 分あれば終わる / hard: 15 分あれば終わる / tedious: それ以上かかる。wait は easy にする",
  },
  mode: { type: "string", enum: ["serial", "parallel"], description: "serial: 前の手順が済んでから / parallel: 前の手順と並行してできる" },
} as const;

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
    canMergeAsIs: {
      type: "boolean",
      description: "mergeable_after_fix でも、条件付きで修正せずにそのまま merge してよいなら true。mergeable なら true、not_mergeable なら false",
    },
    fixEffort: {
      type: "string",
      enum: ["easy", "normal", "hard", "tedious"],
      description:
        "修正にかかる手間。easy: 10 秒で終わる（1 行の書き換えなど）/ normal: 5 分あれば終わる / hard: 15 分あれば終わる / tedious: それ以上かかる。修正が要らなければ easy",
    },
    nextActions: {
      type: "array",
      minItems: 1,
      description: "自分（ユーザー本人）が次にやること。順番に並べる",
      items: {
        type: "object",
        properties: {
          ...REVIEW_STEP_PROPERTIES,
          options: {
            type: "array",
            description: "やり方を選ぶ必要があるとき（修正するかそのまま merge するか、など）だけ、選択肢と選んだあとの手順。なければ空配列",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                steps: {
                  type: "array",
                  minItems: 1,
                  items: { type: "object", properties: REVIEW_STEP_PROPERTIES, required: ["title", "type", "effort", "mode"], additionalProperties: false },
                },
              },
              required: ["label", "steps"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "type", "effort", "mode", "options"],
        additionalProperties: false,
      },
    },
    mergeAsIsNote: {
      type: "string",
      description: "mergeable_after_fix で canMergeAsIs が true のとき、そのまま merge してよい条件（例: fork からの PR を受け付けないなら）。それ以外は空文字",
    },
  },
  required: ["conclusion", "impact", "requiredChanges", "blockers", "configChanges", "canMergeAsIs", "mergeAsIsNote", "fixEffort", "nextActions"],
  additionalProperties: false,
} as const;

/**
 * 調査で使ってよいツール。作業ディレクトリ（--restricted で閉じる）のファイルを読むことだけを許す。
 * PR の本文や依存先のリリースノートに仕込まれた指示で動かされる前提で、外へ送れるもの・書けるものは渡さない。
 * Bash を渡さない理由: 許可をコマンド名で絞っても、読み取りだけとみなされたコマンド（git status など）は
 * 確認なしで通り、絞りきれない。PR の本文・CI・差分はアプリが gh で先に集めて、ファイルとして渡す。
 */
export const DEPENDENCY_REVIEW_TOOLS: ReadonlyArray<string> = ["Read", "Grep", "Glob"];

export function dependencyReviewPrompt(subject: { url: string; repository: string; title: string; contextDir: string }): string {
  return [
    "依存関係を更新する bot の PR を調べ、merge してよいかを判断してください。",
    "",
    `PR: ${subject.url}`,
    `リポジトリ: ${subject.repository}（作業ディレクトリに既定のブランチを clone してあります）`,
    `タイトル: ${subject.title}`,
    "",
    "調べ方:",
    `- ${subject.contextDir}/pr.json に PR の本文（リリースノートを含む）・変更したファイル・CI の結果がある`,
    `- ${subject.contextDir}/pr.diff に PR の差分がある`,
    `- ${subject.contextDir}/open-prs.json にリポジトリで開いている PR の一覧、${subject.contextDir}/dependency-dashboard.md に renovate の Dependency Dashboard がある`,
    "- 本文のリリースノートで、破壊的変更を確かめる",
    "- 作業ディレクトリのコードを Grep / Read して、そのパッケージを使っている箇所と影響を確かめる",
    "",
    "答えること:",
    "- 結論: mergeable（そのまま merge できる）/ mergeable_after_fix（修正すれば merge できる）/ not_mergeable（merge できない）",
    "- 影響範囲の調査結果（どこに影響があり、なぜそう判断したか）",
    "- 修正が必要なら、具体的にどこをどう直すか",
    "- merge できないなら、その理由と、renovate / dependabot の設定ファイルをどう直せばよいか",
    "- 修正すれば merge できる場合でも、条件付きで修正せずにそのまま merge してよいなら、そのことと条件",
    "- 自分が次にやること（手順の並び）。先に別の依存の更新が要るなら、その PR がもう開いているかを open-prs.json で確かめ、" +
      "まだなら Dependency Dashboard（dependency-dashboard.md）で今すぐ作らせるか、出るのを待つ（wait）手順にする",
    "",
    "書き込みはしないでください（コメント・承認・push・ファイルの編集など）。調べて答えるだけにしてください。",
    "日本語で、根拠となるファイル名やリリースノートの記述を添えて答えてください。",
  ].join("\n");
}
