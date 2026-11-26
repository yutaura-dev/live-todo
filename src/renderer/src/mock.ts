import type { Board, BoardCard, ConfigDocument, LiveTodoApi, MovableStatus } from "../../shared/api.js";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

let cards: BoardCard[] = [
  { id: 1, title: "payment の redis gem を v6 へ更新する（acme/platform）", status: "needs_review", unreadChanges: 1, updatedAt: ago(4), url: "https://github.com/acme/platform/pull/1", source: "github:personal", judgment: { method: "decisions", probability: 0.24 } },
  { id: 2, title: "【調査依頼】演習問題の回答ができない事象（acme/support）", status: "needs_review", unreadChanges: 0, updatedAt: ago(30), url: "https://github.com/acme/support/issues/2", source: "github:personal", judgment: { method: "structured", reason: "チームへのメンションで、調査の担当が自分かどうかは本文からは確定できない。" } },
  { id: 3, title: "🚀 Weekly Release at 2026-11-24 15:43:59（acme/platform）", status: "needs_review", unreadChanges: 0, updatedAt: ago(90), url: "https://github.com/acme/platform/pull/3", source: "github:personal", judgment: { method: "decisions", probability: 0.05 } },
  { id: 4, title: "PR #42 の conflict を解消する（acme/app）", status: "todo", unreadChanges: 2, updatedAt: ago(12), url: "https://github.com/acme/app/pull/42", source: "github:personal:watch" },
  { id: 5, title: "Add retry to sync（acme/app）", status: "todo", unreadChanges: 0, updatedAt: ago(200), url: "https://github.com/acme/app/pull/40", source: "github:personal" },
  { id: 6, title: "PR #178091 の CI の失敗を直す（acme/platform）", status: "in_progress", unreadChanges: 0, updatedAt: ago(45), url: "https://github.com/acme/platform/pull/178091", source: "github:personal:watch" },
  { id: 7, title: "実行済みの一回限りのジョブを削除する（acme/platform）", status: "done", unreadChanges: 0, updatedAt: ago(600), url: "https://github.com/acme/platform/pull/7", source: "github:personal" },
];

const COLUMNS = [
  { id: "needs_review", title: "要確認" },
  { id: "todo", title: "Todo" },
  { id: "in_progress", title: "進行中" },
  { id: "done", title: "完了" },
] as const;

const board = (): Board => ({
  columns: COLUMNS.map((column) => ({ ...column, cards: cards.filter((card) => card.status === column.id) })),
});

let config: ConfigDocument = {
  llmProfiles: { personal: { provider: "anthropic", model: "claude-haiku-5-5", decisions: { provider: "openai", model: "gpt-6-luna" } } },
  defaultLlmProfile: "personal",
  accounts: [{ kind: "github", id: "personal", repositories: { include: ["acme/*"], exclude: ["acme/legacy", "acem/*"] } }],
};

export const mockApi: LiveTodoApi = {
  board: async () => board(),
  moveTask: async (taskId: number, status: MovableStatus) => {
    cards = cards.map((card) => (card.id === taskId ? { ...card, status } : card));
  },
  taskDetail: async (taskId: number) => {
    const card = cards.find((candidate) => candidate.id === taskId);
    if (card === undefined) throw new Error("not found");
    return {
      id: card.id,
      title: card.title,
      fromRecurring: false,
      brief: null,
      status: card.status,
      createdAt: ago(60 * 24),
      updatedAt: card.updatedAt,
      items: card.url ? [{ role: "tracks", source: card.source ?? "", title: card.title, url: card.url, state: "open", judgment: card.judgment }] : [],
      changes: [
        { kind: "field_changed", field: "status", before: "needs_review", after: card.status, actor: "user", occurredAt: ago(30), unread: false },
        { kind: "created", field: null, before: null, after: null, actor: "sync", occurredAt: ago(60 * 24), unread: false },
      ],
    };
  },
  mergePlan: async () => ({ repository: "acme/app", number: 42, sha: "a".repeat(40), method: "squash", reason: "既定のブランチの最近の commit 30 件中 27 件が squash" }),
  merge: async () => ({ ok: true }),
  requestReview: async () => ({ ok: true }),
  completeStep: async () => ({ ok: true }),
  chooseOption: async () => ({ ok: true }),
  reopenStep: async () => ({ ok: true }),
  replanNextActions: async () => ({ ok: true }),
  testSlack: async () => ({ error: "見本の画面では使えない" }),
  connectSlack: async () => ({ error: "見本の画面では使えない" }),
  slackAction: async () => ({ ok: true }),
  gmailMailTarget: async () => ({ kind: "senders", messages: [] }),
  taskQuestions: async () => [],
  askTask: async () => ({ ok: true }),
  gmailProcess: async () => ({ ok: true }),
  fixPullRequest: async () => ({ ok: true }),
  pullRequestFix: async () => ({ error: "見本の画面では使えない" }),
  pushPullRequestFix: async () => ({ ok: true }),
  addTask: async () => ({ ok: true }),
  recurringList: async () => [],
  recurringGhosts: async () => [],
  recurringCreateNow: async () => ({ ok: true }),
  recurringCreate: async () => ({ ok: true }),
  recurringFromTask: async () => ({ ok: true }),
  recurringUpdate: async () => ({ ok: true }),
  resolveConflicts: async () => ({ ok: true }),
  conflictResolution: async () => ({ error: "見本の画面では使えない" }),
  pushConflictResolution: async () => ({ ok: true }),
  markSeen: async (taskId: number) => {
    cards = cards.map((card) => (card.id === taskId ? { ...card, unreadChanges: 0 } : card));
  },
  openExternal: async (url: string) => {
    console.info("open", url);
  },
  settings: async () => ({
    configPath: "/Users/me/live-todo/config.json",
    config,
    problems: [],
    secrets: { "github.personal.token": "saved", "llm.anthropic.api_key": "env", "llm.openai.api_key": "missing" },
    encryptionAvailable: true,
    githubTokens: {
      personal: {
        login: "octocat",
        scopes: ["repo", "read:org"],
        expiresAt: new Date(now + 5 * 24 * 60 * 60_000).toISOString(),
        verifiedAt: ago(60 * 24 * 80),
        expiryWarning: { daysLeft: 5 },
        missingRecommendedScopes: ["workflow"],
      },
    },
  }),
  saveConfig: async (next) => {
    config = next;
    return { ok: true };
  },
  setSecret: async () => ({ ok: true }),
  removeSecret: async () => ({ ok: true }),
  previewFilter: async (request) => ({
    included: [
      { repository: "acme/app", included: true, reason: { kind: "included_by", pattern: "acme/*" } },
      { repository: "acme/web", included: true, reason: { kind: "included_by", pattern: "acme/*" } },
    ],
    excluded: [
      { repository: "acme/legacy", included: false, reason: { kind: "excluded_by", pattern: "acme/legacy" } },
      { repository: "me/dotfiles", included: false, reason: { kind: "not_in_include" } },
    ],
    unusedPatterns: ["acem/*"],
    targets: request.targets.map((input) =>
      input.includes("legacy")
        ? { input, target: { repository: "acme/legacy", kind: "pull", number: 9 }, decision: { included: false, reason: { kind: "excluded_by", pattern: "acme/legacy" } } }
        : input.startsWith("acme/") || input.includes("github.com/acme/")
          ? { input, target: { repository: "acme/app", kind: "issue", number: 3 }, decision: { included: true, reason: { kind: "included_by", pattern: "acme/*" } } }
          : { input },
    ),
    remote: { status: "loaded", truncated: false },
  }),
};
