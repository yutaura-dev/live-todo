import type { taskChanges, tasks } from "./schema.js";

export type Task = typeof tasks.$inferSelect;
export type TaskStatus = Task["status"];
export type TaskChangeKind = typeof taskChanges.$inferSelect["kind"];

export type TaskWithUnread = Task & { unreadChanges: number };

export type NewTask = Pick<Task, "source" | "externalId" | "title" | "url" | "status" | "fingerprint">;

export type TaskPatch = Partial<Pick<Task, "title" | "url" | "status" | "fingerprint">>;

export type TaskChangeInput = {
  kind: TaskChangeKind;
  detail?: Record<string, unknown>;
  /** false にすると更新マークの対象にしない（作成時の記録など） */
  unread: boolean;
};
