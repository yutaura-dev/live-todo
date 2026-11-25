import { Effect, Schema } from "effect";

const RemoteRepositories = Schema.Array(Schema.Struct({ full_name: Schema.String }));

export type RepositoryChoices = { owners: string[]; repositories: string[] };

/** GitHub の一覧（GET /user/repos）から、フィルタで選べる owner とリポジトリの候補を作る */
export const repositoryChoicesFrom = Effect.fnUntraced(function* (remote: unknown) {
  const list = yield* Schema.decodeUnknownEffect(RemoteRepositories)(remote);
  // フィルタは大文字と小文字を区別しないので、候補も小文字にそろえて重複をまとめる
  const repositories = [...new Set(list.map((repository) => repository.full_name.toLowerCase()))].sort();
  const owners = [...new Set(repositories.map((name) => name.split("/")[0] ?? ""))].filter((owner) => owner !== "").sort();
  return { owners, repositories } satisfies RepositoryChoices;
});
