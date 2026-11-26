CREATE TABLE `gmail_rule_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`rule_name` text NOT NULL,
	`actions` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`executed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_rule_runs_message_rule` ON `gmail_rule_runs` (`account_id`,`message_id`,`rule_id`);