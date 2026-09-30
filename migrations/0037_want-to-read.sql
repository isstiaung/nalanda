CREATE TABLE `purchase_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_links_item_url` ON `purchase_links` (`item_id`,`url`);--> statement-breakpoint
CREATE TABLE `wants` (
	`item_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`user_id`, `item_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_wants_item` ON `wants` (`item_id`);--> statement-breakpoint
ALTER TABLE `shares` ADD `want_user_id` integer REFERENCES users(id);