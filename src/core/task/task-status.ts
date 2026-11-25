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
