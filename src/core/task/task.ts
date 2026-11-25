import { Schema } from "effect";

export const TaskStatus = Schema.Literals(["todo", "in_progress", "done", "needs_review", "dismissed", "archived"]);
export type TaskStatus = typeof TaskStatus.Type;

export const TaskChangeKind = Schema.Literals(["created", "content_updated", "status_changed", "source_removed"]);
export type TaskChangeKind = typeof TaskChangeKind.Type;

export const Task = Schema.Struct({
  id: Schema.Int,
  source: Schema.String,
  externalId: Schema.String,
  title: Schema.String,
  url: Schema.String,
  status: TaskStatus,
  fingerprint: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Task = typeof Task.Type;

export const TaskWithUnread = Schema.Struct({
  ...Task.fields,
  unreadChanges: Schema.Int,
});
export type TaskWithUnread = typeof TaskWithUnread.Type;

export type NewTask = Pick<Task, "source" | "externalId" | "title" | "url" | "status" | "fingerprint">;

export type TaskPatch = Partial<Pick<Task, "title" | "url" | "status" | "fingerprint">>;

export type TaskChangeInput = {
  kind: TaskChangeKind;
  detail?: Record<string, unknown>;
  /** false にすると更新マークの対象にしない（作成時の記録など） */
  unread: boolean;
};
