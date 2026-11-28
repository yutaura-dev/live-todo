import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { GitHubClient } from "../../../sources/github/github-adapter.js";
import { GitHubClientLive } from "../../../sources/github/github-client-live.js";
import { DocumentStore } from "../../../store/document-store.js";
import { accounts } from "../sources/account-service.js";
import { GitHubScope } from "../sources/gateway.js";

/** 書き込む前に確かめた、今の姿（版・書き込める状態・見せる説明） */
export type Inspection = { ready: "書き込める" | "書き込めない"; version: string | null; summary: string; reason: string | null };
export type WriteOutcome = { ok: true } | { ok: false; kind: "権限が足りない" | "書き込み先のエラー"; message: string };

/** 書き込める操作（Generation の計画の catalog に渡す。ここにないものは計画に書かせない） */
export const WRITE_OPERATIONS = [{ name: "github.merge", description: 'PR を merge する。subjectUri は PR の uri、paramsJson は {"method":"squash"|"merge"|"rebase"}' }] as const;

/** 外へ書き込む口（Source ごとの provider）。承認されたものだけを渡す（呼ぶのは WriteService だけ） */
export class WriteProvider extends Context.Service<
  WriteProvider,
  {
    inspect(subjectUri: string, operation: string, params: unknown): Effect.Effect<Inspection>;
    execute(subjectUri: string, operation: string, params: unknown, version: string | null): Effect.Effect<WriteOutcome>;
  }
>()("live-todo/desktop/WriteProvider") {
  static readonly live = (env: Readonly<Record<string, string | undefined>>) =>
    Layer.effect(
      WriteProvider,
      Effect.gen(function* () {
        const docs = yield* DocumentStore;
        /** uri（github://login@github.com/owner/repo/pull/N）から、アカウントのトークンと PR を引く */
        const locate = (uri: string) =>
          Effect.gen(function* () {
            const match = /^(github:\/\/[^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(uri);
            if (match === null) return null;
            const [, origin, owner, repo, number] = match as unknown as [string, string, string, string, string];
            const account = (yield* accounts.all().pipe(Effect.orElseSucceed(() => []))).find((a) => a.origin === origin && a.status === "つないでいる");
            if (account === undefined) return null;
            const scope = yield* Schema.decodeUnknownEffect(GitHubScope)(account.scope).pipe(Effect.option);
            const token = Option.isSome(scope) ? env[scope.value.secret] : undefined;
            if (token === undefined) return null;
            return { repository: `${owner}/${repo}`, number: Number(number), apiUrl: `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, token };
          }).pipe(Effect.provideService(DocumentStore, docs));

        const client = (token: string) => GitHubClientLive({ token: Redacted.make(token) }).pipe(Layer.provide(FetchHttpClient.layer));
        const Pull = Schema.Struct({ state: Schema.String, merged: Schema.optional(Schema.Boolean), head: Schema.Struct({ sha: Schema.String }), title: Schema.String });

        const inspect = (subjectUri: string, operation: string, params: unknown): Effect.Effect<Inspection> =>
          Effect.gen(function* () {
            if (operation !== "github.merge") return { ready: "書き込めない", version: null, summary: operation, reason: "この操作には、まだ対応していません" } as Inspection;
            const target = yield* locate(subjectUri);
            if (target === null) return { ready: "書き込めない", version: null, summary: "merge する", reason: "この PR のアカウントがつながっていません" } as Inspection;
            const method = (params as { method?: string } | null)?.method ?? "squash";
            return yield* Effect.gen(function* () {
              const raw = yield* (yield* GitHubClient).getPullRequest(target.apiUrl);
              if (Option.isNone(raw)) return { ready: "書き込めない", version: null, summary: "merge する", reason: "PR が見つかりません" } as Inspection;
              const pull = yield* Schema.decodeUnknownEffect(Pull)(raw.value);
              const open = pull.state === "open" && pull.merged !== true;
              return {
                ready: open ? "書き込める" : "書き込めない",
                version: pull.head.sha,
                summary: `「${pull.title}」（${target.repository}#${target.number}）を ${method} で merge する`,
                reason: open ? null : "PR がもう開いていません",
              } as Inspection;
            }).pipe(Effect.provide(client(target.token)), Effect.orElseSucceed(() => ({ ready: "書き込めない", version: null, summary: "merge する", reason: "GitHub に問い合わせられませんでした" }) as Inspection));
          });

        const execute = (subjectUri: string, operation: string, params: unknown, version: string | null): Effect.Effect<WriteOutcome> =>
          Effect.gen(function* () {
            const target = yield* locate(subjectUri);
            if (operation !== "github.merge" || target === null || version === null) return { ok: false, kind: "書き込み先のエラー", message: "書き込み先が見つかりません" } as WriteOutcome;
            const method = ((params as { method?: string } | null)?.method ?? "squash") as "squash" | "merge" | "rebase";
            return yield* Effect.gen(function* () {
              return yield* (yield* GitHubClient).mergePullRequest({ repository: target.repository, number: target.number, sha: version, method });
            }).pipe(
              Effect.as({ ok: true } as WriteOutcome),
              Effect.catch((error) =>
                Effect.succeed(
                  "status" in error && (error.status === 403 || error.status === 401)
                    ? ({ ok: false, kind: "権限が足りない", message: "merge する権限がありません。リポジトリの権限を確かめてください" } as WriteOutcome)
                    : ({ ok: false, kind: "書き込み先のエラー", message: "GitHub が merge を断りました。GitHub の画面から確かめてください" } as WriteOutcome),
                ),
              ),
              Effect.provide(client(target.token)),
            );
          });

        return WriteProvider.of({ inspect, execute });
      }),
    );
}
