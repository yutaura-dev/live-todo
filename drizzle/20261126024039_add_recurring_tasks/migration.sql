CREATE TABLE `recurring_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`next_actions` text,
	`schedule` text NOT NULL,
	`last_period` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `recurring_task_id` integer REFERENCES recurring_tasks(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `recurrence_period` text;