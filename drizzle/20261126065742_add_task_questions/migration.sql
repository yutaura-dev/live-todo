CREATE TABLE `task_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer NOT NULL,
	`question` text NOT NULL,
	`status` text NOT NULL,
	`answer` text,
	`sources` text,
	`error` text,
	`session_id` text,
	`workspace` text,
	`cost_usd` text,
	`asked_at` text NOT NULL,
	`answered_at` text,
	CONSTRAINT `fk_task_questions_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE INDEX `task_questions_task_id` ON `task_questions` (`task_id`);