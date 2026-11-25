import type { Board, BoardCard, LiveTodoApi, MovableStatus } from "../../shared/api.js";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

let cards: BoardCard[] = [
  { id: 1, title: "aya-payment の redis gem を v6 へ更新する（quipper/monorepo）", status: "needs_review", unreadChanges: 1, updatedAt: ago(4), url: "https://github.com/quipper/monorepo/pull/1", source: "github:personal", judgment: { method: "decisions", probability: 0.24 } },
  { id: 2, title: "【調査依頼】演習問題の回答ができない事象（quipper/tara-issues）", status: "needs_review", unreadChanges: 0, updatedAt: ago(30), url: "https://github.com/quipper/tara-issues/issues/2", source: "github:personal", judgment: { method: "structured", reason: "チームへのメンションで、調査の担当が自分かどうかは本文からは確定できない。" } },
  { id: 3, title: "🚀 Weekly Release at 2026-11-24 15:43:59（quipper/monorepo）", status: "needs_review", unreadChanges: 0, updatedAt: ago(90), url: "https://github.com/quipper/monorepo/pull/3", source: "github:personal", judgment: { method: "decisions", probability: 0.05 } },
  { id: 4, title: "PR #42 の conflict を解消する（acme/app）", status: "todo", unreadChanges: 2, updatedAt: ago(12), url: "https://github.com/acme/app/pull/42", source: "github:personal:watch" },
  { id: 5, title: "Add retry to sync（acme/app）", status: "todo", unreadChanges: 0, updatedAt: ago(200), url: "https://github.com/acme/app/pull/40", source: "github:personal" },
  { id: 6, title: "PR #178091 の CI の失敗を直す（quipper/monorepo）", status: "in_progress", unreadChanges: 0, updatedAt: ago(45), url: "https://github.com/quipper/monorepo/pull/178091", source: "github:personal:watch" },
  { id: 7, title: "back-office: 実行済みの oneshot ジョブを削除する（quipper/monorepo）", status: "done", unreadChanges: 0, updatedAt: ago(600), url: "https://github.com/quipper/monorepo/pull/7", source: "github:personal" },
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

export const mockApi: LiveTodoApi = {
  board: async () => board(),
  moveTask: async (taskId: number, status: MovableStatus) => {
    cards = cards.map((card) => (card.id === taskId ? { ...card, status } : card));
  },
  markSeen: async (taskId: number) => {
    cards = cards.map((card) => (card.id === taskId ? { ...card, unreadChanges: 0 } : card));
  },
  openExternal: async (url: string) => {
    console.info("open", url);
  },
};
