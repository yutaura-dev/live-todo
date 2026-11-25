export const TASK_STATUSES = ["todo", "in_progress", "done", "needs_review", "dismissed", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_CHANGE_KINDS = ["created", "field_changed", "link_added"] as const;
export type TaskChangeKind = (typeof TASK_CHANGE_KINDS)[number];

export const LINK_ROLES = ["tracks", "context"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export const CHANGE_ACTORS = ["sync", "user"] as const;
export type ChangeActor = (typeof CHANGE_ACTORS)[number];
