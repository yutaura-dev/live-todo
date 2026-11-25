CREATE TABLE `sync_cursors` (
	`source` text PRIMARY KEY,
	`cursor` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer NOT NULL,
	`kind` text NOT NULL,
	`detail` text,
	`occurred_at` text NOT NULL,
	`seen_at` text,
	CONSTRAINT `fk_task_changes_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_changes_unread` ON `task_changes` (`task_id`) WHERE "task_changes"."seen_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_source_external_id` ON `tasks` (`source`,`external_id`);