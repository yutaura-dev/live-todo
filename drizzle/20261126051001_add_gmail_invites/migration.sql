ALTER TABLE `gmail_messages` ADD `invite_checked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `gmail_messages` ADD `invite_state` text;--> statement-breakpoint
ALTER TABLE `gmail_messages` ADD `invite_ends_at` integer;