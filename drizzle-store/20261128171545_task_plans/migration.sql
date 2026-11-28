ALTER TABLE `tasks` ADD `plan` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `previous_plans` text DEFAULT '[]' NOT NULL;