import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ACTIVITY_KINDS, ITEM_STATES, ITEM_TRIAGES } from "../source/source-item.js";
import { CHANGE_ACTORS, LINK_ROLES, TASK_CHANGE_KINDS, TASK_STATUSES } from "../task/task.js";

export const sourceItems = sqliteTable(
  "source_items",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    source: text().notNull(),
    externalId: text("external_id").notNull(),
    title: text().notNull(),
    url: text().notNull(),
    state: text({ enum: ITEM_STATES }).notNull(),
    fingerprint: text().notNull(),
    triage: text({ enum: ITEM_TRIAGES }).notNull(),
    /** 仕分けたときの判定（方法・確率・理由・LLM に渡した入力）。対象外にしたものも後から見直せるようにする */
    judgment: text({ mode: "json" }),
    firstSeenAt: text("first_seen_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("source_items_source_external_id").on(table.source, table.externalId)],
);

export const activities = sqliteTable(
  "activities",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    sourceItemId: integer("source_item_id")
      .notNull()
      .references(() => sourceItems.id),
    kind: text({ enum: ACTIVITY_KINDS }).notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [index("activities_source_item_id").on(table.sourceItemId)],
);

export const tasks = sqliteTable("tasks", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  brief: text(),
  status: text({ enum: TASK_STATUSES }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const taskLinks = sqliteTable(
  "task_links",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    sourceItemId: integer("source_item_id")
      .notNull()
      .references(() => sourceItems.id),
    role: text({ enum: LINK_ROLES }).notNull(),
    linkedAt: text("linked_at").notNull(),
  },
  (table) => [
    // source_item_id を一意にする理由: 1 つの Item が属せる Task を 1 つに限るため（ADR-0007）。
    uniqueIndex("task_links_source_item_id").on(table.sourceItemId),
    index("task_links_task_id").on(table.taskId),
  ],
);

export const taskChanges = sqliteTable(
  "task_changes",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    kind: text({ enum: TASK_CHANGE_KINDS }).notNull(),
    field: text(),
    before: text({ mode: "json" }),
    after: text({ mode: "json" }),
    /** 誰が変えたか。ユーザーの操作だけを、判定の正解として集めるため */
    actor: text({ enum: CHANGE_ACTORS }).notNull().default("sync"),
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
