import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  /** この Task についての事実の ID（JSON の配列） */
  sourceItemIds: text("source_item_ids").notNull().default("[]"),
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

/** 優先度の決まり方（Task 1 つに 1 つまで。spec の task.aggregate の不変条件） */
export const prioritizations = sqliteTable("prioritizations", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => tasks.id),
  status: text("status").notNull(),
  /** いま見せるラベル（JSON。{ level, reason }） */
  priority: text("priority"),
  basisFingerprint: text("basis_fingerprint").notNull(),
  drivenByItemId: text("driven_by_item_id"),
});

/** AI 設定（PC に 1 つなので、id は 1 だけ）。API キーは持たない（.env.local に置く） */
export const aiSettings = sqliteTable("ai_settings", {
  id: integer("id").primaryKey(),
  /** AiSettings（JSON） */
  settings: text("settings").notNull(),
});

/** 事実（Source Item）。uri で同じ事実かを決め、Adapter が返す外の ID（API の URL など）でも引けるようにする */
export const sourceItems = sqliteTable(
  "source_items",
  {
    id: text("id").primaryKey(),
    uri: text("uri").notNull(),
    accountId: text("account_id").notNull(),
    externalId: text("external_id").notNull(),
    /** SourceItem（JSON） */
    body: text("body").notNull(),
  },
  (table) => [uniqueIndex("source_items_uri").on(table.uri), uniqueIndex("source_items_external").on(table.accountId, table.externalId)],
);

/**
 * ID で引いて丸ごと保存するだけのもの（提案・アカウント・振り分け・取り込みの記録）。
 * 種類ごとに表を分けない理由: どれも中身で検索せず、ドメインの Schema で読み書きするだけなので、表を増やすと移行の手間だけが増える
 */
export const documents = sqliteTable(
  "documents",
  {
    kind: text("kind").notNull(),
    id: text("id").notNull(),
    body: text("body").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.id] }), index("documents_kind").on(table.kind)],
);
