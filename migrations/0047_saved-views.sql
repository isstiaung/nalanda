CREATE TABLE `saved_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`library_id` integer NOT NULL,
	`name` text NOT NULL,
	`params` text NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_saved_views_name` ON `saved_views` (`library_id`,`name`);