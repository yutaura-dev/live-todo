import type { ItemState } from "../source/source-item.js";
import type { TaskStatus } from "./task.js";

const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set(["todo", "in_progress", "needs_review"]);
const CLOSED_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "archived"]);

export function deriveTaskStatus(current: TaskStatus, trackedItemStates: readonly ItemState[]): TaskStatus {
  if (current === "dismissed" || trackedItemStates.length === 0) return current;

  if (trackedItemStates.includes("open")) {
    return CLOSED_STATUSES.has(current) ? "todo" : current;
  }
  if (trackedItemStates.includes("resolved")) {
    return OPEN_STATUSES.has(current) || current === "archived" ? "done" : current;
  }
  return OPEN_STATUSES.has(current) ? "archived" : current;
}

// 処理中は AI が裏で書き換えている途中で、終わったときに処理前の status へ戻す。途中で動かすとその戻しで上書きされるので、ユーザーには動かさせない
export function canUserMove(status: TaskStatus): boolean {
  return status !== "agent_running";
}
