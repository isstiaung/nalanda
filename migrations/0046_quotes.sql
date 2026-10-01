CREATE TABLE `quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`user_id` integer,
	`text` text NOT NULL,
	`page` text,
	`note` text,
	`shared` integer DEFAULT false NOT NULL,
	`source` text,
	`at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_quotes_item` ON `quotes` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_quotes_user` ON `quotes` (`user_id`);