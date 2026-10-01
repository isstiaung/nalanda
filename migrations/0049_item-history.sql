CREATE TABLE `acting` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`session_key` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `item_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`field` text NOT NULL,
	`before` text,
	`after` text,
	`changed_by` integer,
	`changed_key` text,
	`at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_item_history_item` ON `item_history` (`item_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_item_history_at` ON `item_history` (`at`);