CREATE TABLE `agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`subject_fingerprint` text NOT NULL,
	`previous_status` text NOT NULL,
	`result` text,
	`error` text,
	`session_id` text,
	`cost_usd` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	CONSTRAINT `fk_agent_runs_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_threads` (
	`task_id` integer PRIMARY KEY,
	`provider` text NOT NULL,
	`session_id` text NOT NULL,
	`workspace` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_agent_threads_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
ALTER TABLE `source_items` ADD `author` text;--> statement-breakpoint
CREATE INDEX `agent_runs_task_id` ON `agent_runs` (`task_id`);