import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export const TaskMigrations = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_create_tasks": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          external_id TEXT NOT NULL,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          status TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (source, external_id)
        )
      `;
      yield* sql`
        CREATE TABLE task_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks (id),
          kind TEXT NOT NULL,
          detail TEXT,
          occurred_at TEXT NOT NULL,
          seen_at TEXT
        )
      `;
      yield* sql`CREATE INDEX task_changes_unread ON task_changes (task_id) WHERE seen_at IS NULL`;
      yield* sql`
        CREATE TABLE sync_cursors (
          source TEXT PRIMARY KEY,
          cursor TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      // 列名の変換をビューにまとめる理由: SELECT のたびに AS で別名を書くと、列を増やしたときに書き漏れが起きるため。
      yield* sql`
        CREATE VIEW task_rows AS
        SELECT
          t.id,
          t.source,
          t.external_id AS externalId,
          t.title,
          t.url,
          t.status,
          t.fingerprint,
          t.created_at AS createdAt,
          t.updated_at AS updatedAt,
          (SELECT COUNT(*) FROM task_changes c WHERE c.task_id = t.id AND c.seen_at IS NULL) AS unreadChanges
        FROM tasks t
      `;
    }),
  }),
});
