import { describe, expect, it, vi } from "vitest";
import notifications from "./__fixtures__/notifications.json" with { type: "json" };
import mergedPull from "./__fixtures__/pull-42-merged.json" with { type: "json" };
import closedIssue from "./__fixtures__/issue-7-closed.json" with { type: "json" };
import {
  createGitHubAdapter,
  githubTodoRules,
  type GitHubAdapterOptions,
  type GitHubClient,
  type GitHubItem,
  type GitHubNotification,
  type GitHubSubjectDetail,
} from "./github-adapter.js";

const NOW = new Date("2026-11-25T00:00:00Z");

const PULL_URL = "https://api.github.com/repos/acme/app/pulls/42";
const ISSUE_URL = "https://api.github.com/repos/acme/app/issues/7";

const openPull = { ...mergedPull, state: "open", merged: false };
const openIssue = { ...closedIssue, state: "open", state_reason: null };

function clientWith(options: {
  notifications?: GitHubNotification[];
  subjects?: Record<string, GitHubSubjectDetail | null>;
}): GitHubClient {
  return {
    listNotifications: vi.fn().mockResolvedValue(options.notifications ?? []),
    getSubject: vi.fn(async (url: string) => options.subjects?.[url] ?? null),
  };
}

const allSubjectsOpen = { [PULL_URL]: openPull, [ISSUE_URL]: openIssue };

function adapterWith(client: GitHubClient, extra: Partial<GitHubAdapterOptions> = {}) {
  return createGitHubAdapter({ client, now: () => NOW, initialLookbackDays: 14, ...extra });
}

function upsertedItems(changes: Awaited<ReturnType<ReturnType<typeof adapterWith>["fetchChanges"]>>["changes"]): GitHubItem[] {
  return changes.flatMap((change) => (change.kind === "upserted" ? [change.item] : []));
}

describe("通知の取得条件", () => {
  it("初回は lookback 期間の開始時刻から、既読の通知も含めて取得する", async () => {
    const client = clientWith({});

    await adapterWith(client).fetchChanges(null);

    expect(client.listNotifications).toHaveBeenCalledWith({ since: "2026-11-11T00:00:00.000Z", all: true });
  });

  it("2 回目以降は前回のカーソルから、既読の通知も含めて取得する", async () => {
    const client = clientWith({});

    await adapterWith(client).fetchChanges({ since: "2026-11-24T10:30:00Z" });

    expect(client.listNotifications).toHaveBeenCalledWith({ since: "2026-11-24T10:30:00Z", all: true });
  });
});

describe("通知から GitHubItem への変換", () => {
  it("PR の通知を、理由・タイトル・リポジトリ・Web の URL 付きで返す", async () => {
    const client = clientWith({ notifications, subjects: allSubjectsOpen });

    const { changes } = await adapterWith(client).fetchChanges(null);

    expect(upsertedItems(changes)).toContainEqual({
      externalId: PULL_URL,
      reason: "review_requested",
      subjectType: "PullRequest",
      title: "Add retry to sync",
      repository: "acme/app",
      htmlUrl: "https://github.com/acme/app/pull/42",
      state: "open",
      updatedAt: "2026-11-24T09:00:00Z",
    });
  });

  it("マージ済みの PR は state を merged にする", async () => {
    const client = clientWith({ notifications, subjects: { ...allSubjectsOpen, [PULL_URL]: mergedPull } });

    const { changes } = await adapterWith(client).fetchChanges(null);

    expect(upsertedItems(changes).find((item) => item.externalId === PULL_URL)?.state).toBe("merged");
  });

  it("閉じられた Issue は state を closed にする", async () => {
    const client = clientWith({ notifications, subjects: { ...allSubjectsOpen, [ISSUE_URL]: closedIssue } });

    const { changes } = await adapterWith(client).fetchChanges(null);

    expect(upsertedItems(changes).find((item) => item.externalId === ISSUE_URL)?.state).toBe("closed");
  });

  it("subject の URL がない通知（CI など）は状態を取りに行かず、通知 ID で識別して state を unknown にする", async () => {
    const client = clientWith({ notifications, subjects: allSubjectsOpen });

    const { changes } = await adapterWith(client).fetchChanges(null);

    expect(upsertedItems(changes)).toContainEqual({
      externalId: "github:thread:1003",
      reason: "ci_activity",
      subjectType: "CheckSuite",
      title: "CI workflow run failed for main branch",
      repository: "acme/app",
      htmlUrl: "https://github.com/acme/app",
      state: "unknown",
      updatedAt: "2026-11-24T08:15:00Z",
    });
    expect(client.getSubject).toHaveBeenCalledTimes(2);
  });

  it("対象の PR や Issue が見つからない（削除・権限喪失）ときは removed として返す", async () => {
    const client = clientWith({ notifications, subjects: { [PULL_URL]: openPull } });

    const { changes } = await adapterWith(client).fetchChanges(null);

    expect(changes).toContainEqual({ kind: "removed", externalId: ISSUE_URL });
  });
});

describe("次回のカーソル", () => {
  it("取得した通知のうち最も新しい updated_at を次回のカーソルにする", async () => {
    const client = clientWith({ notifications, subjects: allSubjectsOpen });

    const { nextCursor } = await adapterWith(client).fetchChanges(null);

    expect(nextCursor).toEqual({ since: "2026-11-24T10:30:00Z" });
  });

  it("通知がなかったときは今回使ったカーソルをそのまま返す", async () => {
    const client = clientWith({});

    const { nextCursor } = await adapterWith(client).fetchChanges({ since: "2026-11-20T00:00:00Z" });

    expect(nextCursor).toEqual({ since: "2026-11-20T00:00:00Z" });
  });
});

describe("リポジトリのフィルター", () => {
  const otherOrgNotification: GitHubNotification = {
    id: "2001",
    reason: "assign",
    updated_at: "2026-11-24T23:00:00Z",
    subject: { title: "Private task", url: "https://api.github.com/repos/personal/dotfiles/issues/1", type: "Issue" },
    repository: { full_name: "personal/dotfiles", html_url: "https://github.com/personal/dotfiles" },
  };
  const allNotifications = [...notifications, otherOrgNotification];

  it("フィルターに一致しないリポジトリの通知は返さず、対象の PR や Issue も取りに行かない", async () => {
    const client = clientWith({ notifications: allNotifications, subjects: allSubjectsOpen });

    const { changes } = await adapterWith(client, { repositoryFilter: { include: ["acme/*"] } }).fetchChanges(null);

    expect(upsertedItems(changes).map((item) => item.repository)).not.toContain("personal/dotfiles");
    expect(client.getSubject).not.toHaveBeenCalledWith(otherOrgNotification.subject.url);
  });

  it("除外した通知も次回のカーソルの計算に含める", async () => {
    const client = clientWith({ notifications: allNotifications, subjects: allSubjectsOpen });

    const { nextCursor } = await adapterWith(client, { repositoryFilter: { include: ["acme/*"] } }).fetchChanges(null);

    expect(nextCursor).toEqual({ since: "2026-11-24T23:00:00Z" });
  });
});

describe("githubTodoRules", () => {
  const itemWithReason = (reason: string): GitHubItem => ({
    externalId: "x",
    reason,
    subjectType: "PullRequest",
    title: "t",
    repository: "acme/app",
    htmlUrl: "https://github.com/acme/app/pull/1",
    state: "open",
    updatedAt: "2026-11-24T00:00:00Z",
  });

  it.each(["review_requested", "assign", "ci_activity"])("理由が %s の項目は規則で todo にする", (reason) => {
    expect(githubTodoRules.some((rule) => rule(itemWithReason(reason)))).toBe(true);
  });

  it.each(["mention", "author", "comment", "subscribed"])("理由が %s の項目は規則では決めない", (reason) => {
    expect(githubTodoRules.some((rule) => rule(itemWithReason(reason)))).toBe(false);
  });

  it("閉じられた PR へのレビュー依頼は規則で todo にしない", () => {
    expect(githubTodoRules.some((rule) => rule({ ...itemWithReason("review_requested"), state: "merged" }))).toBe(false);
  });
});
