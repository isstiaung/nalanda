CREATE TABLE `editions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`format` text,
	`isbn` text,
	`publisher` text,
	`year` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_editions_item` ON `editions` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_editions_isbn` ON `editions` (`isbn`);--> statement-breakpoint
ALTER TABLE `items` ADD `formats` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `loans` ADD `edition` text;