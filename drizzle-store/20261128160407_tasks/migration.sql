CREATE TABLE `task_activities` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`by` text NOT NULL,
	`occurred_at` text NOT NULL,
	`changes` text NOT NULL,
	`cause` text,
	CONSTRAINT `task_activities_pk` PRIMARY KEY(`task_id`, `seq`),
	CONSTRAINT `fk_task_activities_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY,
	`status` text NOT NULL,
	`closure` text,
	`pending_reason` text,
	`completion` text NOT NULL,
	`title` text NOT NULL,
	`brief` text,
	`due` text,
	`blocks_others` integer NOT NULL,
	`last_seen_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
