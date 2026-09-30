CREATE TABLE `reading_goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`year` integer NOT NULL,
	`target` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reading_goals_user_year` ON `reading_goals` (`user_id`,`year`);--> statement-breakpoint
ALTER TABLE `site_settings` ADD `goals_to_connections` integer DEFAULT false NOT NULL;