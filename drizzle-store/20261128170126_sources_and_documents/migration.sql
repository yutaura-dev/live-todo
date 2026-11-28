CREATE TABLE `documents` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `documents_pk` PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE TABLE `source_items` (
	`id` text PRIMARY KEY,
	`uri` text NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `documents_kind` ON `documents` (`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_items_uri` ON `source_items` (`uri`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_items_external` ON `source_items` (`account_id`,`external_id`);