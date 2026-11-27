import { Option } from "effect";
import type { NotionOrigin } from "../sources/notion/notion-client-live.js";

export type CookieLike = { name: string; value: string; domain?: string | undefined };
export type NotionSession = { token: string; userId: string; origin: NotionOrigin };

const isNotionHost = (host: string, root: "notion.so" | "notion.com") => host === root || host.endsWith(`.${root}`);
const rootOf = (domain: string | undefined) => {
  const host = (domain ?? "").replace(/^\./, "");
  if (isNotionHost(host, "notion.so")) return "notion.so" as const;
  if (isNotionHost(host, "notion.com")) return "notion.com" as const;
  return undefined;
};

function userIdFrom(cookies: ReadonlyArray<CookieLike>): string | undefined {
  const single = cookies.find((cookie) => cookie.name === "notion_user_id" && cookie.value !== "");
  if (single !== undefined) return single.value;
  const list = cookies.find((cookie) => cookie.name === "notion_users");
  if (list === undefined) return undefined;
  try {
    const users: unknown = JSON.parse(decodeURIComponent(list.value));
    return Array.isArray(users) && typeof users[0] === "string" ? users[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ログイン画面のセッションの Cookie から、Notion のセッション（token_v2 とユーザー）を読む。
 * 接続先は token_v2 の Cookie のドメインで決める（notion.so から notion.com への移行中のため。ADR-0015）
 */
export function notionSessionFrom(cookies: ReadonlyArray<CookieLike>): Option.Option<NotionSession> {
  const token = cookies.find((cookie) => cookie.name === "token_v2" && cookie.value !== "" && rootOf(cookie.domain) !== undefined);
  if (token === undefined) return Option.none();
  const root = rootOf(token.domain);
  const userId = userIdFrom(cookies.filter((cookie) => rootOf(cookie.domain) === root));
  if (userId === undefined) return Option.none();
  return Option.some({ token: token.value, userId, origin: root === "notion.com" ? "https://app.notion.com" : "https://www.notion.so" });
}

/** 設定（検証前の JSON）の Notion のアカウントに、ログインで読み取ったユーザー・User-Agent・接続先を書く */
export function withNotionSession(
  document: unknown,
  session: { id: string; userId: string; userAgent: string; origin: NotionOrigin },
): Record<string, unknown> {
  const base = typeof document === "object" && document !== null ? (document as Record<string, unknown>) : {};
  const accounts = Array.isArray(base["notionAccounts"]) ? (base["notionAccounts"] as Array<Record<string, unknown>>) : [];
  const fields = { userId: session.userId, userAgent: session.userAgent, origin: session.origin };
  const exists = accounts.some((account) => account["id"] === session.id);
  const notionAccounts = exists
    ? accounts.map((account) => (account["id"] === session.id ? { ...account, ...fields } : account))
    : [...accounts, { kind: "notion", id: session.id, ...fields }];
  return { ...base, notionAccounts };
}

/** ログイン用のウィンドウの中で開いてよいページ（Notion の https のページだけ） */
export function isNotionUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && rootOf(parsed.hostname) !== undefined;
}
