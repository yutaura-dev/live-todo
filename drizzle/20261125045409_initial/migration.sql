CREATE TABLE `activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source_item_id` integer NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` text NOT NULL,
	CONSTRAINT `fk_activities_source_item_id_source_items_id_fk` FOREIGN KEY (`source_item_id`) REFERENCES `source_items`(`id`)
);
--> statement-breakpoint
CREATE TABLE `source_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`fingerprint` text NOT NULL,
	`triage` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
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
	`field` text,
	`before` text,
	`after` text,
	`occurred_at` text NOT NULL,
	`seen_at` text,
	CONSTRAINT `fk_task_changes_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `task_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer NOT NULL,
	`source_item_id` integer NOT NULL,
	`role` text NOT NULL,
	`linked_at` text NOT NULL,
	CONSTRAINT `fk_task_links_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `fk_task_links_source_item_id_source_items_id_fk` FOREIGN KEY (`source_item_id`) REFERENCES `source_items`(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`brief` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activities_source_item_id` ON `activities` (`source_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_items_source_external_id` ON `source_items` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `task_changes_unread` ON `task_changes` (`task_id`) WHERE "task_changes"."seen_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `task_links_source_item_id` ON `task_links` (`source_item_id`);--> statement-breakpoint
CREATE INDEX `task_links_task_id` ON `task_links` (`task_id`);