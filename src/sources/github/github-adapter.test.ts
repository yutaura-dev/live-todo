import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import notifications from "./__fixtures__/notifications.json" with { type: "json" };
import mergedPull from "./__fixtures__/pull-42-merged.json" with { type: "json" };
import closedIssue from "./__fixtures__/issue-7-closed.json" with { type: "json" };
import type { SourceChange } from "../../core/sync/source-change.js";
import {
  GitHubClient,
  type GitHubAdapterOptions,
  type GitHubCursor,
  type GitHubItem,
  GitHubResponseError,
  githubTodoRules,
  makeGitHubAdapter,
} from "./github-adapter.js";
import { gitHubClientStub } from "./test-client.js";

const NOW = Date.parse("2026-11-25T00:00:00Z");

const PULL_URL = "https://api.github.com/repos/acme/app/pulls/42";
const ISSUE_URL = "https://api.github.com/repos/acme/app/issues/7";

const openPull = { ...mergedPull, state: "open", merged: false };
const openIssue = { ...closedIssue, state: "open", state_reason: null };
const allSubjectsOpen: Record<string, unknown> = { [PULL_URL]: openPull, [ISSUE_URL]: openIssue };

function clientWith(options: { notifications?: unknown[]; truncated?: boolean; subjects?: Record<string, unknown> }) {
  return gitHubClientStub({
    listNotifications: vi.fn(() =>
      Effect.succeed({ notifications: options.notifications ?? [], truncated: options.truncated ?? false }),
    ),
    getSubject: vi.fn((url: string) => Effect.succeed(Option.fromNullishOr(options.subjects?.[url]))),
  });
}

const fetchWith = (
  client: GitHubClient["Service"],
  cursor: GitHubCursor | null,
  extra: Partial<GitHubAdapterOptions> = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const adapter = yield* makeGitHubAdapter({ initialLookbackDays: 14, ...extra });
    return yield* adapter.fetchChanges(cursor);
  }).pipe(Effect.provideService(GitHubClient, client));

const upsertedItems = (changes: readonly SourceChange<GitHubItem>[]): GitHubItem[] =>
  changes.flatMap((change) => (change.kind === "upserted" ? [change.item] : []));

describe("通知の取得条件", () => {
  it.effect("初回は lookback 期間の開始時刻から、既読の通知も含めて取得する", () =>
    Effect.gen(function* () {
      const client = clientWith({});

      yield* fetchWith(client, null);

      expect(client.listNotifications).toHaveBeenCalledWith({ since: "2026-11-11T00:00:00.000Z", all: true });
    }));

  it.effect("2 回目以降は前回のカーソルから、既読の通知も含めて取得する", () =>
    Effect.gen(function* () {
      const client = clientWith({});

      yield* fetchWith(client, { since: "2026-11-24T10:30:00Z" });

      expect(client.listNotifications).toHaveBeenCalledWith({ since: "2026-11-24T10:30:00Z", all: true });
    }));
});

describe("通知から GitHubItem への変換", () => {
  it.effect("PR の通知を、理由・タイトル・リポジトリ・Web の URL 付きで返す", () =>
    Effect.gen(function* () {
      const { changes } = yield* fetchWith(clientWith({ notifications, subjects: allSubjectsOpen }), null);

      assert.deepInclude(upsertedItems(changes), {
        externalId: PULL_URL,
        reason: "review_requested",
        subjectType: "PullRequest",
        title: "Add retry to sync",
        repository: "acme/app",
        htmlUrl: "https://github.com/acme/app/pull/42",
        state: "open",
        updatedAt: "2026-11-24T09:00:00Z",
      });
    }));

  it.effect("マージ済みの PR は state を merged にする", () =>
    Effect.gen(function* () {
      const client = clientWith({ notifications, subjects: { ...allSubjectsOpen, [PULL_URL]: mergedPull } });

      const { changes } = yield* fetchWith(client, null);

      assert.strictEqual(upsertedItems(changes).find((item) => item.externalId === PULL_URL)?.state, "merged");
    }));

  it.effect("閉じられた Issue は state を closed にする", () =>
    Effect.gen(function* () {
      const client = clientWith({ notifications, subjects: { ...allSubjectsOpen, [ISSUE_URL]: closedIssue } });

      const { changes } = yield* fetchWith(client, null);

      assert.strictEqual(upsertedItems(changes).find((item) => item.externalId === ISSUE_URL)?.state, "closed");
    }));

  it.effect("subject の URL がない通知（CI など）は状態を取りに行かず、通知 ID で識別して state を unknown にする", () =>
    Effect.gen(function* () {
      const client = clientWith({ notifications, subjects: allSubjectsOpen });

      const { changes } = yield* fetchWith(client, null);

      assert.deepInclude(upsertedItems(changes), {
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
    }));

  it.effect("対象の PR や Issue が見つからない（削除・権限喪失）ときは removed として返す", () =>
    Effect.gen(function* () {
      const { changes } = yield* fetchWith(clientWith({ notifications, subjects: { [PULL_URL]: openPull } }), null);

      assert.deepInclude(changes, { kind: "removed", externalId: ISSUE_URL });
    }));

  it.effect("通知の応答が想定した形でないときはエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(fetchWith(clientWith({ notifications: [{ id: 1 }] }), null));

      assert.instanceOf(error, GitHubResponseError);
    }));
});

describe("次回のカーソル", () => {
  it.effect("取得した通知のうち最も新しい updated_at を次回のカーソルにする", () =>
    Effect.gen(function* () {
      const { nextCursor } = yield* fetchWith(clientWith({ notifications, subjects: allSubjectsOpen }), null);

      assert.deepStrictEqual(nextCursor, { since: "2026-11-24T10:30:00Z" });
    }));

  it.effect("通知がなかったときは今回使ったカーソルをそのまま返す", () =>
    Effect.gen(function* () {
      const { nextCursor } = yield* fetchWith(clientWith({}), { since: "2026-11-20T00:00:00Z" });

      assert.deepStrictEqual(nextCursor, { since: "2026-11-20T00:00:00Z" });
    }));
});

describe("打ち切られた通知の続き", () => {
  const older = (id: string, updatedAt: string) => ({ ...notifications[2], id, updated_at: updatedAt });

  it.effect("取得が上限で打ち切られたら、次回のカーソルに続きの範囲を入れる", () =>
    Effect.gen(function* () {
      const client = clientWith({ notifications, truncated: true, subjects: allSubjectsOpen });

      const { nextCursor } = yield* fetchWith(client, null);

      assert.deepStrictEqual(nextCursor, {
        since: "2026-11-11T00:00:00.000Z",
        backfill: { before: "2026-11-24T08:15:00Z", newest: "2026-11-24T10:30:00Z" },
      });
    }));

  it.effect("続きの範囲があるときは、since と before で古い側を取りに行く", () =>
    Effect.gen(function* () {
      const client = clientWith({ notifications: [older("900", "2026-11-20T00:00:00Z")] });

      yield* fetchWith(client, {
        since: "2026-11-11T00:00:00.000Z",
        backfill: { before: "2026-11-24T08:15:00Z", newest: "2026-11-24T10:30:00Z" },
      });

      expect(client.listNotifications).toHaveBeenCalledWith({
        since: "2026-11-11T00:00:00.000Z",
        before: "2026-11-24T08:15:00Z",
        all: true,
      });
    }));

  it.effect("続きを取り切ったら、最初の取得で一番新しかった時刻から通常の差分取得に戻る", () =>
    Effect.gen(function* () {
      const client = clientWith({ notifications: [older("900", "2026-11-20T00:00:00Z")] });

      const { nextCursor } = yield* fetchWith(client, {
        since: "2026-11-11T00:00:00.000Z",
        backfill: { before: "2026-11-24T08:15:00Z", newest: "2026-11-24T10:30:00Z" },
      });

      assert.deepStrictEqual(nextCursor, { since: "2026-11-24T10:30:00Z" });
    }));

  it.effect("続きの取得もまた打ち切られたら、さらに古い側へ進む", () =>
    Effect.gen(function* () {
      const client = clientWith({
        notifications: [older("900", "2026-11-20T00:00:00Z"), older("901", "2026-11-18T00:00:00Z")],
        truncated: true,
      });

      const { nextCursor } = yield* fetchWith(client, {
        since: "2026-11-11T00:00:00.000Z",
        backfill: { before: "2026-11-24T08:15:00Z", newest: "2026-11-24T10:30:00Z" },
      });

      assert.deepStrictEqual(nextCursor, {
        since: "2026-11-11T00:00:00.000Z",
        backfill: { before: "2026-11-18T00:00:00Z", newest: "2026-11-24T10:30:00Z" },
      });
    }));
});

describe("リポジトリのフィルター", () => {
  const otherOrgNotification = {
    id: "2001",
    reason: "assign",
    updated_at: "2026-11-24T23:00:00Z",
    subject: { title: "Private task", url: "https://api.github.com/repos/personal/dotfiles/issues/1", type: "Issue" },
    repository: { full_name: "personal/dotfiles", html_url: "https://github.com/personal/dotfiles" },
  };
  const allNotifications = [...notifications, otherOrgNotification];

  it.effect("フィルターに一致しないリポジトリの通知は返さず、対象の PR や Issue も取りに行かない", () =>
    Effect.gen(function* () {
      const client = clientWith({ notifications: allNotifications, subjects: allSubjectsOpen });

      const { changes } = yield* fetchWith(client, null, { repositoryFilter: { include: ["acme/*"] } });

      assert.notInclude(upsertedItems(changes).map((item) => item.repository), "personal/dotfiles");
      expect(client.getSubject).not.toHaveBeenCalledWith(otherOrgNotification.subject.url);
    }));

  it.effect("除外した通知も次回のカーソルの計算に含める", () =>
    Effect.gen(function* () {
      const client = clientWith({ notifications: allNotifications, subjects: allSubjectsOpen });

      const { nextCursor } = yield* fetchWith(client, null, { repositoryFilter: { include: ["acme/*"] } });

      assert.deepStrictEqual(nextCursor, { since: "2026-11-24T23:00:00Z" });
    }));
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
    assert.isTrue(githubTodoRules.some((rule) => rule(itemWithReason(reason))));
  });

  it.each(["mention", "author", "comment", "subscribed"])("理由が %s の項目は規則では決めない", (reason) => {
    assert.isFalse(githubTodoRules.some((rule) => rule(itemWithReason(reason))));
  });

  it("閉じられた PR へのレビュー依頼は規則で todo にしない", () => {
    assert.isFalse(githubTodoRules.some((rule) => rule({ ...itemWithReason("review_requested"), state: "merged" })));
  });
});
