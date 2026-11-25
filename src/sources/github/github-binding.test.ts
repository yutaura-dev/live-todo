import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../../core/db/test-database.js";
import { StructuredClassifier } from "../../core/judge/todo-judge.js";
import { SourceItemRepository } from "../../core/source/source-item-repository.js";
import { syncSource } from "../../core/sync/sync-source.js";
import { TaskRepository } from "../../core/task/task-repository.js";
import notifications from "./__fixtures__/notifications.json" with { type: "json" };
import mergedPull from "./__fixtures__/pull-42-merged.json" with { type: "json" };
import closedIssue from "./__fixtures__/issue-7-closed.json" with { type: "json" };
import { GitHubClient, type GitHubItem, GitHubRequestError } from "./github-adapter.js";
import { githubItemDraft, makeGitHubBinding } from "./github-binding.js";
import { gitHubClientStub } from "./test-client.js";

const PULL_URL = "https://api.github.com/repos/acme/app/pulls/42";
const ISSUE_URL = "https://api.github.com/repos/acme/app/issues/7";

const githubItem = (overrides: Partial<GitHubItem> = {}): GitHubItem => ({
  externalId: PULL_URL,
  reason: "review_requested",
  subjectType: "PullRequest",
  title: "Add retry to sync",
  repository: "acme/app",
  htmlUrl: "https://github.com/acme/app/pull/42",
  state: "open",
  updatedAt: "2026-11-24T09:00:00Z",
  ...overrides,
});

describe("githubItemDraft", () => {
  it.each([
    ["open", "open"],
    ["unknown", "open"],
    ["merged", "resolved"],
    ["closed", "resolved"],
  ] as const)("GitHub の状態 %s は Item の状態 %s にする", (state, expected) => {
    assert.strictEqual(githubItemDraft(githubItem({ state })).state, expected);
  });

  it("タイトルにはリポジトリ名を添え、Web の URL を Item に引き継ぐ", () => {
    const draft = githubItemDraft(githubItem());

    assert.strictEqual(draft.title, "Add retry to sync（acme/app）");
    assert.strictEqual(draft.url, "https://github.com/acme/app/pull/42");
  });

  it("新しい動き（updated_at の変化）があると fingerprint が変わる", () => {
    const before = githubItemDraft(githubItem());
    const after = githubItemDraft(githubItem({ updatedAt: "2026-11-24T10:00:00Z" }));

    assert.notStrictEqual(before.fingerprint, after.fingerprint);
  });

  it("何も変わっていなければ fingerprint は同じ", () => {
    assert.strictEqual(githubItemDraft(githubItem()).fingerprint, githubItemDraft(githubItem()).fingerprint);
  });
});

describe("makeGitHubBinding", () => {
  it.effect("アカウントごとに別の Source 名を使う", () =>
    Effect.gen(function* () {
      const binding = yield* makeGitHubBinding({ accountId: "work", initialLookbackDays: 14 });

      assert.strictEqual(binding.source, "github:work");
    }).pipe(Effect.provideService(GitHubClient, gitHubClientStub())));
});

describe("LLM に渡す説明文", () => {
  const mention = githubItem({
    externalId: "https://api.github.com/repos/acme/app/issues/7",
    reason: "mention",
    subjectType: "Issue",
    title: "Login fails on Safari",
    author: "carol",
    bodyExcerpt: "Safari 17 でログインできない",
    latestCommentUrl: "https://api.github.com/repos/acme/app/issues/comments/555",
  });

  const captureDescriptions = (client: GitHubClient["Service"], items: GitHubItem[]) =>
    Effect.gen(function* () {
      const inputs: string[] = [];
      const contexts: string[] = [];
      const classifier = StructuredClassifier.of({
        classifyTodo: (request) => {
          inputs.push(request.input);
          contexts.push(request.context ?? "");
          return Effect.succeed<unknown>("todo");
        },
      });
      const binding = yield* makeGitHubBinding({ accountId: "work", initialLookbackDays: 14 });
      for (const item of items) yield* binding.judge(item).pipe(Effect.provideService(StructuredClassifier, classifier));
      return Object.assign(inputs, { contexts });
    }).pipe(Effect.provideService(GitHubClient, client));

  it.effect("本文の冒頭・作成者・最新のコメント・自分のアカウント名を説明文に含める", () =>
    Effect.gen(function* () {
      const client = gitHubClientStub({
        getComment: () => Effect.succeed(Option.some<unknown>({ user: { login: "dave" }, body: "@YutaUra 確認お願いします" })),
        getViewer: Effect.succeed<unknown>({ login: "YutaUra" }),
      });

      const captured = yield* captureDescriptions(client, [mention]);
      const [input] = captured;
      const [context] = captured.contexts;

      assert.include(input, "Safari 17 でログインできない");
      assert.include(input, "@dave");
      assert.include(input, "@YutaUra 確認お願いします");
      assert.include(context, "あなた（ユーザー本人）の GitHub アカウント: @YutaUra");
      assert.include(context, "carol");
    }));

  it.effect("自分のアカウント名・通知の理由などの信頼できる情報は評価対象に入れず、外部から来た文字列だけを評価対象にする", () =>
    Effect.gen(function* () {
      const client = gitHubClientStub({ getViewer: Effect.succeed<unknown>({ login: "YutaUra" }) });

      const captured = yield* captureDescriptions(client, [mention]);

      assert.notInclude(captured[0], "@YutaUra");
      assert.notInclude(captured[0], "通知の理由");
      assert.include(captured.contexts[0], "通知の理由: mention");
      assert.include(captured[0], "Login fails on Safari");
    }));

  it.effect("規則で決まった通知では、最新のコメントを取りに行かない", () =>
    Effect.gen(function* () {
      const getComment = vi.fn(() => Effect.succeed(Option.none<unknown>()));
      const client = gitHubClientStub({ getComment });

      yield* captureDescriptions(client, [githubItem({ reason: "review_requested", latestCommentUrl: "https://api.github.com/x" })]);

      expect(getComment).not.toHaveBeenCalled();
    }));

  it.effect("最新のコメントが取れなくても、コメントなしの説明文で判定を続ける", () =>
    Effect.gen(function* () {
      const client = gitHubClientStub({
        getComment: () => Effect.fail(new GitHubRequestError({ message: "500", status: 500 })),
      });

      const inputs = yield* captureDescriptions(client, [mention]);

      assert.strictEqual(inputs.length, 1);
      assert.include(inputs[0], "Safari 17 でログインできない");
    }));

  it.effect("自分のアカウント名は、何件判定しても 1 回だけ取りに行く", () =>
    Effect.gen(function* () {
      const getViewer = vi.fn(() => ({ login: "YutaUra" }));
      const client = gitHubClientStub({ getViewer: Effect.sync(getViewer) });

      yield* captureDescriptions(client, [mention, { ...mention, externalId: "other" }]);

      expect(getViewer).toHaveBeenCalledTimes(1);
    }));
});

describe("GitHub の通知から Task まで", () => {
  const openPull = { ...mergedPull, state: "open", merged: false };
  const openIssue = { ...closedIssue, state: "open", state_reason: null };

  /** subjects は参照で受け取り、テストの途中で PR の状態を書き換えられるようにする */
  const clientServing = (subjects: Record<string, unknown>, batches: unknown[][]) => {
    const listNotifications = vi.fn();
    for (const batch of batches) listNotifications.mockReturnValueOnce(Effect.succeed({ notifications: batch, truncated: false }));
    return gitHubClientStub({
      listNotifications,
      getSubject: (url: string) => Effect.succeed(Option.fromNullishOr(subjects[url])),
    });
  };

  const classifierAnswering = (answer: string) =>
    StructuredClassifier.of({ classifyTodo: vi.fn(() => Effect.succeed<unknown>(answer)) });

  const tasksByUrl = Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const all = yield* tasks.listTasks;
    const result: Record<string, string> = {};
    for (const externalId of [PULL_URL, ISSUE_URL, "github:thread:1003"]) {
      const item = yield* items.findItem("github:work", externalId);
      if (Option.isNone(item)) continue;
      const task = yield* tasks.findTaskByItem(item.value.id);
      result[externalId] = Option.match(task, {
        onNone: () => `(${item.value.triage})`,
        onSome: (found) => all.find((candidate) => candidate.id === found.id)?.status ?? "?",
      });
    }
    return result;
  });

  const runSync = (client: GitHubClient["Service"], classifier: StructuredClassifier["Service"], times: number) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
      const binding = yield* makeGitHubBinding({ accountId: "work", initialLookbackDays: 14 });
      for (let index = 0; index < times; index++) yield* syncSource(binding);
    }).pipe(Effect.provideService(GitHubClient, client), Effect.provideService(StructuredClassifier, classifier));

  it.effect("レビュー依頼と CI の通知は LLM を呼ばずに Task にし、LLM が not_todo と答えたメンションも隠さず要確認にする", () =>
    Effect.gen(function* () {
      const classifier = classifierAnswering("not_todo");
      const client = clientServing({ [PULL_URL]: openPull, [ISSUE_URL]: openIssue }, [notifications]);

      yield* runSync(client, classifier, 1);

      assert.deepStrictEqual(yield* tasksByUrl, {
        [PULL_URL]: "todo",
        [ISSUE_URL]: "needs_review",
        "github:thread:1003": "todo",
      });
      expect(classifier.classifyTodo).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("PR がマージされたら、その PR の Task を done にする", () =>
    Effect.gen(function* () {
      const subjects: Record<string, unknown> = { [PULL_URL]: openPull, [ISSUE_URL]: openIssue };
      const mergedNotification = { ...notifications[0], updated_at: "2026-11-24T12:00:00Z" };
      const client = clientServing(subjects, [notifications, [mergedNotification]]);
      const classifier = classifierAnswering("todo");

      yield* runSync(client, classifier, 1);
      subjects[PULL_URL] = mergedPull;
      yield* runSync(client, classifier, 1);

      assert.strictEqual((yield* tasksByUrl)[PULL_URL], "done");
    }).pipe(Effect.provide(TestDatabase)));
});
