import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const TASK_STATUSES = ["todo", "in_progress", "done", "needs_review", "dismissed", "archived"] as const;
export const TASK_CHANGE_KINDS = ["created", "content_updated", "status_changed", "source_removed"] as const;

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    source: text().notNull(),
    externalId: text("external_id").notNull(),
    title: text().notNull(),
    url: text().notNull(),
    status: text({ enum: TASK_STATUSES }).notNull(),
    fingerprint: text().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("tasks_source_external_id").on(table.source, table.externalId)],
);

export const taskChanges = sqliteTable(
  "task_changes",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    kind: text({ enum: TASK_CHANGE_KINDS }).notNull(),
    detail: text({ mode: "json" }),
    occurredAt: text("occurred_at").notNull(),
    seenAt: text("seen_at"),
  },
  (table) => [index("task_changes_unread").on(table.taskId).where(sql`${table.seenAt} IS NULL`)],
);

export const syncCursors = sqliteTable("sync_cursors", {
  source: text().primaryKey(),
  cursor: text({ mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});
