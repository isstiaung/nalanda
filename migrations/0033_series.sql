CREATE TABLE `series` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`total` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_key_unique` ON `series` (`key`);--> statement-breakpoint
ALTER TABLE `items` ADD `series_id` integer REFERENCES series(id);--> statement-breakpoint
ALTER TABLE `items` ADD `series_number` real;--> statement-breakpoint
CREATE INDEX `idx_items_series` ON `items` (`series_id`);