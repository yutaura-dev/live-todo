import { inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Database } from "../../core/db/database.js";
import { sourceItems } from "../../core/db/schema.js";
import type { GitHubClientError } from "../../sources/github/github-adapter.js";
import { githubSourceName } from "../../sources/github/github-binding.js";
import {
  explainRepositoryFilter,
  type GitHubTarget,
  parseGitHubTarget,
  previewRepositoryFilter,
  type RepositoryFilterPreview,
} from "../../sources/github/repository-filter-preview.js";
import type { FilterDecision, RepositoryFilterConfig } from "../../sources/github/repository-filter.js";

const RemoteRepositories = Schema.Array(Schema.Struct({ full_name: Schema.String }));
const decodeRemoteRepositories = Schema.decodeUnknownEffect(RemoteRepositories);

export type TargetCheck = { input: string; target?: GitHubTarget; decision?: FilterDecision };

export type AccountFilterPreview = RepositoryFilterPreview & {
  targets: TargetCheck[];
  /** GitHub から一覧を取れたか。取れなくても、手元に届いた項目だけでプレビューする */
  remote: { status: "loaded"; truncated: boolean } | { status: "failed"; message: string };
};

export const previewAccountFilter = Effect.fnUntraced(function* (options: {
  accountId: string;
  filter: RepositoryFilterConfig;
  targets: ReadonlyArray<string>;
  listRemote: Effect.Effect<{ repositories: unknown; truncated: boolean }, GitHubClientError>;
}) {
  const explain = yield* explainRepositoryFilter(options.filter);

  const db = yield* Database;
  const sources = [githubSourceName(options.accountId), `${githubSourceName(options.accountId)}:watch`];
  const localRows = yield* db.select({ url: sourceItems.url }).from(sourceItems).where(inArray(sourceItems.source, sources)).pipe(Effect.orDie);
  const localRepositories = localRows.flatMap(({ url }) => {
    const target = parseGitHubTarget(url);
    return target === undefined ? [] : [target.repository];
  });

  const remote = yield* options.listRemote.pipe(
    Effect.flatMap(({ repositories, truncated }) =>
      decodeRemoteRepositories(repositories).pipe(
        Effect.map((list) => ({ names: list.map((repository) => repository.full_name), status: { status: "loaded" as const, truncated } })),
        Effect.mapError((error) => ({ message: `GitHub の応答の形が想定と違う: ${error.message}` })),
      ),
    ),
    Effect.catch((error) => Effect.succeed({ names: [], status: { status: "failed" as const, message: error.message } })),
  );

  const preview = yield* previewRepositoryFilter(options.filter, [...remote.names, ...localRepositories]);
  const targets = options.targets.map((input): TargetCheck => {
    const target = parseGitHubTarget(input);
    return target === undefined ? { input } : { input, target, decision: explain(target.repository) };
  });

  return { ...preview, targets, remote: remote.status } satisfies AccountFilterPreview;
});
