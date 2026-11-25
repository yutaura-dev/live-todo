/** agent_running: AI（Claude Code）が自動で調べている間だけ置く。終わったら元の流れ（todo など）に戻す */
export const TASK_STATUSES = ["todo", "in_progress", "done", "needs_review", "dismissed", "archived", "agent_running"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_CHANGE_KINDS = ["created", "field_changed", "link_added"] as const;
export type TaskChangeKind = (typeof TASK_CHANGE_KINDS)[number];

export const LINK_ROLES = ["tracks", "context"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

/** filter: フィルタで除外したリポジトリの Task を片付けた（ユーザーの判断ではないので、判定の正解には使わない） */
export const CHANGE_ACTORS = ["sync", "user", "filter", "agent"] as const;
export type ChangeActor = (typeof CHANGE_ACTORS)[number];
