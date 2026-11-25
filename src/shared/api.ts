import type { Board } from "../core/board/board-service.js";

export type { Board, BoardCard, BoardColumnId, CardJudgment } from "../core/board/board-service.js";

export type MovableStatus = "needs_review" | "todo" | "in_progress" | "done" | "dismissed";

/** preload が renderer に公開する API。トークンや API キーには触れられない */
export interface LiveTodoApi {
  board(): Promise<Board>;
  moveTask(taskId: number, status: MovableStatus): Promise<void>;
  markSeen(taskId: number): Promise<void>;
  openExternal(url: string): Promise<void>;
}
