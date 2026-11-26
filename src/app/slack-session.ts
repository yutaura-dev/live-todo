import { Option, Schema } from "effect";

const LocalConfig = Schema.Struct({
  teams: Schema.Record(
    Schema.String,
    Schema.Struct({ url: Schema.String, token: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }),
  ),
  lastActiveTeamId: Schema.optional(Schema.String),
});
const decodeLocalConfig = Schema.decodeUnknownOption(Schema.fromJsonString(LocalConfig));

export type TeamSession = { token: string; workspace: string; team: string };

/**
 * Slack の Web クライアントが localStorage（localConfig_v2）に持つ設定から、ワークスペースのセッションのトークンを探す。
 * workspace が空なら、最後に開いていたワークスペースを使う
 */
export function teamSessionFrom(localConfig: string | null, workspace: string): Option.Option<TeamSession> {
  if (localConfig === null) return Option.none();
  return Option.flatMap(decodeLocalConfig(localConfig), (config) => {
    const teams = Object.entries(config.teams).map(([id, team]) => ({ id, ...team, domain: URL.canParse(team.url) ? new URL(team.url).hostname : "" }));
    const team = workspace === "" ? teams.find((candidate) => candidate.id === config.lastActiveTeamId) : teams.find((candidate) => candidate.domain === workspace);
    if (team === undefined || team.token === undefined || !team.token.startsWith("xoxc-")) return Option.none();
    return Option.some({ token: team.token, workspace: team.domain, team: team.name ?? team.domain });
  });
}

/** 設定（検証前の JSON）の Slack のアカウントに、ログインで読み取ったワークスペースと User-Agent を書く */
export function withSlackSession(document: unknown, session: { id: string; workspace: string; userAgent: string }): Record<string, unknown> {
  const base = typeof document === "object" && document !== null ? (document as Record<string, unknown>) : {};
  const accounts = Array.isArray(base["slackAccounts"]) ? (base["slackAccounts"] as Array<Record<string, unknown>>) : [];
  const exists = accounts.some((account) => account["id"] === session.id);
  const slackAccounts = exists
    ? accounts.map((account) => (account["id"] === session.id ? { ...account, workspace: session.workspace, userAgent: session.userAgent } : account))
    : [...accounts, { kind: "slack", id: session.id, workspace: session.workspace, userAgent: session.userAgent }];
  return { ...base, slackAccounts };
}

/** Electron とアプリの名前を除いた、Chrome と同じ形の User-Agent。ログインと同期で同じ値を使う（ADR-0010） */
export const browserUserAgent = (electronUserAgent: string) =>
  electronUserAgent
    .split(" ")
    .filter((part) => !/^(Electron|live-todo)\//.test(part))
    .join(" ");

/** ログイン用のウィンドウの中で開いてよいページ（Slack の https のページだけ） */
export function isSlackLoginUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && (parsed.hostname === "slack.com" || parsed.hostname.endsWith(".slack.com"));
}
