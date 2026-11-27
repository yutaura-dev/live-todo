CREATE TABLE `task_rule_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer NOT NULL,
	`rule_id` text NOT NULL,
	`rule_name` text NOT NULL,
	`rule_fingerprint` text NOT NULL,
	`trigger_key` text NOT NULL,
	`status` text NOT NULL,
	`probability` real,
	`action` text NOT NULL,
	`executed_at` text NOT NULL,
	CONSTRAINT `fk_task_rule_runs_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_rule_runs_once` ON `task_rule_runs` (`task_id`,`rule_id`,`rule_fingerprint`,`trigger_key`);