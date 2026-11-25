CREATE TABLE `approvals` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`approved_at` text NOT NULL,
	`executed_at` text,
	CONSTRAINT `fk_approvals_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `subject_sha` text;--> statement-breakpoint
CREATE INDEX `approvals_task_id` ON `approvals` (`task_id`);