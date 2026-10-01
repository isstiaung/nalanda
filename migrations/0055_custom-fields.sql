CREATE TABLE `custom_fields` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`on_shares` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_custom_fields_name` ON `custom_fields` (lower("name"));--> statement-breakpoint
ALTER TABLE `items` ADD `custom` text DEFAULT '{}' NOT NULL;