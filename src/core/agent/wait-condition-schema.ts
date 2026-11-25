import { Schema } from "effect";

/** AI が返す「何を待つか」。アプリが GitHub を見て、成り立ったら待つ手順を済ませる */
export const ProposedWaitConditionSchema = Schema.Struct({
  kind: Schema.Literals(["pull_request_opened", "review_submitted", "merged", "none"]),
  repository: Schema.String,
  query: Schema.String,
  pullUrl: Schema.String,
});

export const WAIT_CONDITION_JSON_SCHEMA = {
  type: "object",
  description:
    "wait のときに、何が起きたら待ち終わりかを書く。アプリが GitHub を見張って、成り立ったら済ませる。wait でなければ kind は none。kind に要らない項目は空文字",
  properties: {
    kind: {
      type: "string",
      enum: ["pull_request_opened", "review_submitted", "merged", "none"],
      description:
        "pull_request_opened: repository で query に合う PR が開かれる / review_submitted: pullUrl の PR にレビューが付く / merged: pullUrl の PR が merge される / none: アプリでは確かめられない（返信待ちなど）",
    },
    repository: { type: "string", description: "pull_request_opened のときの owner/repo" },
    query: { type: "string", description: "pull_request_opened のときの GitHub の検索語（PR のタイトルに含まれる語など。例: \"@changesets/cli\" v3）" },
    pullUrl: { type: "string", description: "review_submitted・merged のときの PR の URL（https://github.com/owner/repo/pull/番号）" },
  },
  required: ["kind", "repository", "query", "pullUrl"],
  additionalProperties: false,
} as const;

export const WAIT_CONDITION_PROMPT =
  "- wait の手順には until で何を待つかを書く（PR が出るのを待つなら pull_request_opened、レビューなら review_submitted、merge なら merged）。" +
  "アプリが見張って自動で済ませるので、確かめられない待ちだけ none にする";
