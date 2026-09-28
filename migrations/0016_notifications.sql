CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`household_name` text NOT NULL,
	`subject` text,
	`href` text NOT NULL,
	`at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_at` ON `notifications` (`at`);--> statement-breakpoint
ALTER TABLE `users` ADD `notifications_seen_at` text;--> statement-breakpoint
ALTER TABLE `users` ADD `feed_seen_at` text;