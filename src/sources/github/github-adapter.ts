import type { SourceChange } from "../../core/sync/source-change.js";
import type { SourceAdapter } from "../../core/sync/source-adapter.js";
import { createRepositoryFilter, type RepositoryFilterConfig } from "./repository-filter.js";

export type GitHubNotification = {
  id: string;
  reason: string;
  updated_at: string;
  subject: { title: string; url: string | null; type: string };
  repository: { full_name: string; html_url: string };
};

export type GitHubSubjectDetail = {
  state: string;
  merged?: boolean;
  html_url: string;
};

export interface GitHubClient {
  listNotifications(params: { since: string; all: boolean }): Promise<GitHubNotification[]>;
  /** 対象が削除された・見られなくなったときは null を返す */
  getSubject(apiUrl: string): Promise<GitHubSubjectDetail | null>;
}

export type GitHubItemState = "open" | "closed" | "merged" | "unknown";

export type GitHubItem = {
  externalId: string;
  reason: string;
  subjectType: string;
  title: string;
  repository: string;
  htmlUrl: string;
  state: GitHubItemState;
  updatedAt: string;
};

export type GitHubCursor = { since: string };

export type GitHubAdapterOptions = {
  client: GitHubClient;
  now: () => Date;
  initialLookbackDays: number;
  repositoryFilter?: RepositoryFilterConfig;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const RULE_TODO_REASONS = new Set(["review_requested", "assign", "ci_activity"]);

export const githubTodoRules: readonly ((item: GitHubItem) => boolean)[] = [
  (item) => RULE_TODO_REASONS.has(item.reason) && item.state !== "closed" && item.state !== "merged",
];

export function createGitHubAdapter(options: GitHubAdapterOptions): SourceAdapter<GitHubItem, GitHubCursor> {
  const { client, now, initialLookbackDays } = options;
  const isTargetRepository = createRepositoryFilter(options.repositoryFilter ?? {});

  return {
    async fetchChanges(cursor) {
      const since = cursor?.since ?? new Date(now().getTime() - initialLookbackDays * DAY_MS).toISOString();
      // all: true にする理由: 既定の未読のみだと、GitHub の Web で通知を開いて既読にした後の
      // マージ・クローズなどの状態変化が取れなくなるため。
      const notifications = await client.listNotifications({ since, all: true });

      const targets = notifications.filter((notification) => isTargetRepository(notification.repository.full_name));
      const changes = await Promise.all(targets.map((notification) => toChange(client, notification)));

      // フィルター後の targets ではなく全通知からカーソルを作る理由:
      // 除外したリポジトリの通知が最新のとき、カーソルが進まず毎回取得し直すことになるため。
      return { changes, nextCursor: { since: latestUpdatedAt(notifications) ?? since } };
    },
  };
}

async function toChange(client: GitHubClient, notification: GitHubNotification): Promise<SourceChange<GitHubItem>> {
  const base = {
    reason: notification.reason,
    subjectType: notification.subject.type,
    title: notification.subject.title,
    repository: notification.repository.full_name,
    updatedAt: notification.updated_at,
  };

  const apiUrl = notification.subject.url;
  if (apiUrl === null) {
    return {
      kind: "upserted",
      item: { ...base, externalId: `github:thread:${notification.id}`, htmlUrl: notification.repository.html_url, state: "unknown" },
    };
  }

  const detail = await client.getSubject(apiUrl);
  if (detail === null) {
    return { kind: "removed", externalId: apiUrl };
  }

  return { kind: "upserted", item: { ...base, externalId: apiUrl, htmlUrl: detail.html_url, state: stateOf(detail) } };
}

function stateOf(detail: GitHubSubjectDetail): GitHubItemState {
  if (detail.merged === true) return "merged";
  if (detail.state === "open" || detail.state === "closed") return detail.state;
  return "unknown";
}

function latestUpdatedAt(notifications: readonly GitHubNotification[]): string | undefined {
  // 文字列比較で済ませない理由: GitHub は通常 Z 付きの同一形式で返すが、
  // 形式が揺れた場合に辞書順と時刻順がずれるため、時刻として比較する。
  let latest: GitHubNotification | undefined;
  for (const notification of notifications) {
    if (latest === undefined || Date.parse(notification.updated_at) > Date.parse(latest.updated_at)) {
      latest = notification;
    }
  }
  return latest?.updated_at;
}
