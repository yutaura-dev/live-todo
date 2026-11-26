import { Schema } from "effect";

/** AI が返す「何を待つか」。アプリが GitHub を見て、成り立ったら待つ手順を済ませる */
export const ProposedWaitConditionSchema = Schema.Struct({
  kind: Schema.Literals(["pull_request_opened", "review_submitted", "merged", "included_in_pull_request", "workflow_succeeded", "none"]),
  repository: Schema.String,
  query: Schema.String,
  pullUrl: Schema.String,
});

export const WAIT_CONDITION_JSON_SCHEMA = {
  type: "object",
  description:
    "wait のときに、何が起きたら待ち終わりかを書く。アプリが GitHub を見張って、成り立ったら済ませる。wait でなければ kind は none（使わない）。kind に要らない項目は空文字",
  properties: {
    kind: {
      type: "string",
      enum: ["pull_request_opened", "review_submitted", "merged", "included_in_pull_request", "workflow_succeeded", "none"],
      description:
        "pull_request_opened: repository で query に合う PR が開かれる / review_submitted: pullUrl の PR にレビューが付く / merged: pullUrl の PR が merge される / included_in_pull_request: pullUrl の PR の merge commit が、repository で query（タイトルの語）に合う開いた PR（deploy の PR など）に入る / workflow_succeeded: pullUrl の PR の merge commit を含む commit で、repository の query（ワークフローのファイル名。例: deploy-stg.yml）が成功する / none: 上のどれでもない（返信待ちなど）。元の項目（PR・issue）に新しい動きがあったら待ち終わりとみなす",
    },
    repository: { type: "string", description: "pull_request_opened・included_in_pull_request・workflow_succeeded のときの owner/repo" },
    query: {
      type: "string",
      description:
        "pull_request_opened・included_in_pull_request のときは PR のタイトルの検索語（例: \"@changesets/cli\" v3、Deploy stg）。workflow_succeeded のときはワークフローのファイル名",
    },
    pullUrl: { type: "string", description: "review_submitted・merged・included_in_pull_request・workflow_succeeded のときの、自分の PR の URL（https://github.com/owner/repo/pull/番号）" },
  },
  required: ["kind", "repository", "query", "pullUrl"],
  additionalProperties: false,
} as const;

export const WAIT_CONDITION_PROMPT =
  "- wait の手順には until で何を待つかを書く（PR が出るのを待つなら pull_request_opened、レビューなら review_submitted、merge なら merged）。" +
  "アプリが見張って自動で済ませる。上のどれにも当たらない待ち（返信待ちなど）は none にすると、元の項目に動きがあったときに済ませる";
