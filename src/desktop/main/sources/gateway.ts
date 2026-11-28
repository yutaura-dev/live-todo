import { Context, Effect, Layer, Option, Schema } from "effect";
import type { Account } from "../../../domain/account/account.js";
import type { ObservedChange } from "../ingest/ingestor.js";
import { fetchGitHub, type GitHubViewer, githubViewer } from "./github.js";

export class SourceFetchError extends Schema.TaggedError<SourceFetchError>()("SourceFetchError", {
  reason: Schema.Literals(["トークンが通らない", "回数の上限", "ネットワーク", "Source のエラー", "想定外の応答"]),
}) {}

/** アカウントが持つ、つなぐのに要る情報（トークンそのものは持たず、.env.local のどの名前かだけ） */
export const GitHubScope = Schema.Struct({ kind: Schema.Literal("github"), secret: Schema.String, login: Schema.String, teams: Schema.Array(Schema.String) });
export type GitHubScope = typeof GitHubScope.Type;

/** 外の Source を呼ぶ口（テストでは差し替える） */
export class SourceGateway extends Context.Service<
  SourceGateway,
  {
    githubViewer(secret: string): Effect.Effect<Option.Option<GitHubViewer>, SourceFetchError>;
    fetch(account: Account, cursor: unknown): Effect.Effect<{ changes: ReadonlyArray<ObservedChange>; nextCursor: unknown }, SourceFetchError>;
  }
>()("live-todo/desktop/SourceGateway") {
  static readonly live = (env: Readonly<Record<string, string | undefined>>) =>
    Layer.succeed(
      SourceGateway,
      SourceGateway.of({
        githubViewer: (secret) => {
          const token = env[secret];
          if (token === undefined || token.trim() === "") return Effect.fail(new SourceFetchError({ reason: "トークンが通らない" }));
          return githubViewer(token);
        },
        fetch: (account, cursor) =>
          Effect.gen(function* () {
            const scope = yield* Schema.decodeUnknownEffect(GitHubScope)(account.scope).pipe(Effect.mapError(() => new SourceFetchError({ reason: "想定外の応答" })));
            const token = env[scope.secret];
            if (token === undefined || token.trim() === "") return yield* new SourceFetchError({ reason: "トークンが通らない" });
            return yield* fetchGitHub({ token, origin: account.origin, viewer: { login: scope.login, teams: scope.teams }, cursor }).pipe(
              Effect.catchTags({
                GitHubRateLimitedError: () => Effect.fail(new SourceFetchError({ reason: "回数の上限" })),
                GitHubResponseError: () => Effect.fail(new SourceFetchError({ reason: "想定外の応答" })),
                InvalidRepositoryPatternError: () => Effect.fail(new SourceFetchError({ reason: "想定外の応答" })),
                GitHubRequestError: (error) =>
                  Effect.fail(new SourceFetchError({ reason: error.status === 401 ? "トークンが通らない" : error.status === undefined ? "ネットワーク" : "Source のエラー" })),
              }),
            );
          }),
      }),
    );
}
