import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 新しいアプリの DB。今のアプリ（src/core/db/schema.ts）とは別のファイル・別のマイグレーション（drizzle-store/）に置く（ADR なし・作り直しの間だけ並べる）

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  /** どう終わったか（JSON。終わったときだけ） */
  closure: text("closure"),
  pendingReason: text("pending_reason"),
  completion: text("completion").notNull(),
  title: text("title").notNull(),
  brief: text("brief"),
  /** 期日（JSON） */
  due: text("due"),
  blocksOthers: integer("blocks_others", { mode: "boolean" }).notNull(),
  lastSeenAt: text("last_seen_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Task Activity。足すだけで書き換えない（seq は Task の中での順番） */
export const taskActivities = sqliteTable(
  "task_activities",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    by: text("by").notNull(),
    occurredAt: text("occurred_at").notNull(),
    /** 変わった項目（JSON） */
    changes: text("changes").notNull(),
    cause: text("cause"),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.seq] })],
);
