import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    /** 作成者（GitHub の login など）。依存更新の bot の PR を見分けるため */
    author: text(),
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

/** 定期の Task の決まり。時期が来たら Task を作る（src/core/task/recurrence.ts） */
export const recurringTasks = sqliteTable("recurring_tasks", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  /** 作る Task の状況（brief）に載せるメモ（その月だけの注意など） */
  note: text().notNull().default(""),
  /** 作る Task に持たせる次にやることのひな形 */
  nextActions: text("next_actions", { mode: "json" }),
  schedule: text({ mode: "json" }).notNull(),
  /** 最後に Task を作った月（"YYYY-MM"）。同じ月の分を二度作らない。Task を消しても作り直さない */
  lastPeriod: text("last_period"),
  active: integer({ mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  brief: text(),
  /** 次にやること（手順の並び。src/core/task/next-actions.ts） */
  nextActions: text("next_actions", { mode: "json" }),
  status: text({ enum: TASK_STATUSES }).notNull(),
  /** AI が「定期の Task にした方がよい」と提案したときの下書き（毎月何日・何日前から・タイトル・メモ・理由） */
  recurringSuggestion: text("recurring_suggestion", { mode: "json" }),
  /** 定期の Task から作ったなら、その決まりと何月分か */
  recurringTaskId: integer("recurring_task_id").references(() => recurringTasks.id),
  recurrencePeriod: text("recurrence_period"),
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

/** queued: 調査待ち（AI が調査中のレーンに入れて順番を待つ） */
export const AGENT_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

/** Task ごとの AI Agent との会話（Agent Thread）。Claude Code の session を続けて使うため、id と作業場所を残す */
export const agentThreads = sqliteTable("agent_threads", {
  taskId: integer("task_id")
    .primaryKey()
    .references(() => tasks.id),
  provider: text().notNull(),
  sessionId: text("session_id").notNull(),
  /** session は作業ディレクトリに結び付くので、続けるときは同じ場所で動かす */
  workspace: text().notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** AI に任せた作業 1 回ごとの記録 */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    kind: text().notNull(),
    status: text({ enum: AGENT_RUN_STATUSES }).notNull(),
    /** どの状態の元の項目を調べたか。項目が変わったら調べ直すために使う */
    subjectFingerprint: text("subject_fingerprint").notNull(),
    /** 調べたときの PR の head の commit。merge するときに指定し、調べたあとの変更を merge しないようにする */
    subjectSha: text("subject_sha"),
    /** 調べる前の Task の状態。失敗したときにここへ戻す */
    previousStatus: text("previous_status").notNull(),
    result: text({ mode: "json" }),
    error: text(),
    sessionId: text("session_id"),
    costUsd: text("cost_usd"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [index("agent_runs_task_id").on(table.taskId)],
);

export const APPROVAL_STATUSES = ["executed", "failed"] as const;

/** 外部への書き込みを、ユーザーが承認した記録（charter: 承認なしの外部書き込みはしない） */
export const approvals = sqliteTable(
  "approvals",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    action: text().notNull(),
    /** 書き込む先（例: acme/app#42） */
    target: text().notNull(),
    /** 承認したときに見せた内容（merge の方法・commit など） */
    payload: text({ mode: "json" }).notNull(),
    status: text({ enum: APPROVAL_STATUSES }).notNull(),
    error: text(),
    approvedAt: text("approved_at").notNull(),
    executedAt: text("executed_at"),
  },
  (table) => [index("approvals_task_id").on(table.taskId)],
);

export const GMAIL_MAIL_KINDS = ["personal", "notification", "newsletter", "mine"] as const;

/**
 * 取り込んだ Gmail のメール 1 通（ヘッダーとラベルと仕分けの結果。本文は持たない）。
 * 送り主ごと・スレッドごとにまとめた Source Item と、送り主ごとの集計（削除した割合）はここから作る
 */
export const gmailMessages = sqliteTable(
  "gmail_messages",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: text("account_id").notNull(),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id").notNull(),
    senderKey: text("sender_key").notNull(),
    senderName: text("sender_name").notNull(),
    subject: text().notNull(),
    receivedAt: integer("received_at").notNull(),
    kind: text({ enum: GMAIL_MAIL_KINDS }).notNull(),
    /** 仕分けの確率と方法（decisions / fallback）。mine は仕分けないので null */
    probability: real(),
    method: text(),
    inInbox: integer("in_inbox", { mode: "boolean" }).notNull(),
    unread: integer({ mode: "boolean" }).notNull(),
    trashed: integer({ mode: "boolean" }).notNull(),
    /** 配信の解除に使う（List-Unsubscribe・List-Unsubscribe-Post） */
    listUnsubscribe: text("list_unsubscribe"),
    listUnsubscribePost: text("list_unsubscribe_post"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("gmail_messages_account_message").on(table.accountId, table.messageId),
    index("gmail_messages_account_thread").on(table.accountId, table.threadId),
    index("gmail_messages_account_sender").on(table.accountId, table.senderKey),
  ],
);
