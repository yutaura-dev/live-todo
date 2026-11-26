ALTER TABLE `gmail_rule_runs` ADD `rule_fingerprint` text DEFAULT '' NOT NULL;--> statement-breakpoint
DROP INDEX `gmail_rule_runs_message_rule`;--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_rule_runs_message_rule` ON `gmail_rule_runs` (`account_id`,`message_id`,`rule_id`,`rule_fingerprint`);