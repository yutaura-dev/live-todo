CREATE TABLE `gmail_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`sender_key` text NOT NULL,
	`sender_name` text NOT NULL,
	`subject` text NOT NULL,
	`received_at` integer NOT NULL,
	`kind` text NOT NULL,
	`probability` real,
	`method` text,
	`in_inbox` integer NOT NULL,
	`unread` integer NOT NULL,
	`trashed` integer NOT NULL,
	`list_unsubscribe` text,
	`list_unsubscribe_post` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_messages_account_message` ON `gmail_messages` (`account_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `gmail_messages_account_thread` ON `gmail_messages` (`account_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `gmail_messages_account_sender` ON `gmail_messages` (`account_id`,`sender_key`);