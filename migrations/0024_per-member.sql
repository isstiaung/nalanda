CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`user_id` integer,
	`rating` integer,
	`review` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`reviewed_at` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_item_user` ON `reviews` (`item_id`,`user_id`);--> statement-breakpoint
DROP INDEX `reads_one_open`;--> statement-breakpoint
ALTER TABLE `reads` ADD `reader_id` integer REFERENCES users(id);--> statement-breakpoint
CREATE UNIQUE INDEX `reads_one_open_per_reader` ON `reads` (`item_id`,`reader_id`) WHERE "reads"."status" = 'in_progress';