CREATE TABLE `reading_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`page` integer NOT NULL,
	`at` text DEFAULT (datetime('now')) NOT NULL,
	`added_by` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_reading_progress_item` ON `reading_progress` (`item_id`,`at`);--> statement-breakpoint
ALTER TABLE `items` ADD `progress_page` integer;