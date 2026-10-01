CREATE TABLE `translations` (
	`locale` text PRIMARY KEY NOT NULL,
	`strings` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `locale` text;