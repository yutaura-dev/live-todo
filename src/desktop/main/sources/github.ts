import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { GitHubClient, type GitHubItem, makeGitHubAdapter } from "../../../sources/github/github-adapter.js";
import { GitHubClientLive } from "../../../sources/github/github-client-live.js";
import type { Observed, ObservedChange } from "../ingest/ingestor.js";

const STATES: Record<GitHubItem["state"], string> = { open: "開いている", closed: "閉じた", merged: "マージ済み", unknown: "分からない" };
const REASONS: Record<string, string> = {
  review_requested: "レビューを頼まれた",
  assign: "担当にされた",
  mention: "メンションされた",
  team_mention: "チームがメンションされた",
  author: "自分が作った",
  comment: "コメントがついた",
  ci_activity: "CI の結果",
  state_change: "状態が変わった",
  subscribed: "ウォッチしている",
};

export type GitHubViewer = { login: string; teams: ReadonlyArray<string> };

const reviewRequest = (item: GitHubItem, viewer: GitHubViewer) => {
  if (item.requestedReviewers === undefined && item.requestedTeams === undefined) return "なし";
  if ((item.requestedReviewers ?? []).includes(viewer.login)) return "あり";
  const team = (item.requestedTeams ?? []).find((t) => viewer.teams.includes(t));
  return team === undefined ? "なし" : `あり（チーム ${team}）`;
};

/** GitHub の 1 件を、Source を知らない事実の形にする。自分に関わる結論（レビュー依頼があるか）はアプリが決めて 1 行で書く */
export function githubObserved(item: GitHubItem, origin: string, viewer: GitHubViewer): Observed {
  const path = item.htmlUrl.replace(/^https:\/\/github\.com/, "");
  return {
    externalId: item.externalId,
    uri: `${origin}${path}`,
    url: item.htmlUrl,
    stream: "通知",
    snapshot: {
      title: item.title,
      author: item.author ?? null,
      fact: {
        trusted: [
          { key: "種類", value: item.subjectType },
          { key: "状態", value: STATES[item.state] },
          { key: "通知の理由", value: REASONS[item.reason] ?? item.reason },
          { key: "リポジトリ", value: item.repository },
          { key: "あなたへのレビュー依頼", value: reviewRequest(item, viewer) },
        ],
        body: item.bodyExcerpt ?? "",
      },
      sourceUpdatedAt: item.updatedAt,
    },
  };
}

const Viewer = Schema.Struct({ login: Schema.String });

const clientLayer = (token: string) => GitHubClientLive({ token: Redacted.make(token) }).pipe(Layer.provide(FetchHttpClient.layer));

/** トークンの持ち主を確かめる（つなぐときの認証の確かめ）。通らなければ none */
export const githubViewer = (token: string) =>
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    const login = yield* client.getViewer.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Viewer)));
    const teams = yield* client.listMyTeams.pipe(Effect.orElseSucceed(() => []));
    return Option.some<GitHubViewer>({ login: login.login, teams });
  }).pipe(Effect.provide(clientLayer(token)), Effect.orElseSucceed(() => Option.none<GitHubViewer>()));

/** GitHub の通知を、カーソルから先の変化として取る（Adapter はそのまま使う） */
export const fetchGitHub = (input: { token: string; origin: string; viewer: GitHubViewer; cursor: unknown }) =>
  Effect.gen(function* () {
    const adapter = yield* makeGitHubAdapter({ initialLookbackDays: 7 });
    const result = yield* adapter.fetchChanges((input.cursor ?? null) as never);
    const changes: ObservedChange[] = result.changes.map((change) =>
      change.kind === "upserted" ? { kind: "upserted", item: githubObserved(change.item, input.origin, input.viewer) } : { kind: "removed", externalId: change.externalId },
    );
    return { changes, nextCursor: result.nextCursor as unknown };
  }).pipe(Effect.provide(clientLayer(input.token)));
