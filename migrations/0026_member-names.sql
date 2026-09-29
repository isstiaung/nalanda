CREATE TABLE `member_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`kind` text NOT NULL,
	`at` text DEFAULT (datetime('now')) NOT NULL,
	`read_id` integer,
	`review_id` integer,
	`progress_id` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`read_id`) REFERENCES `reads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`progress_id`) REFERENCES `reading_progress`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_activity_read_kind` ON `member_activity` (`kind`,`read_id`) WHERE "member_activity"."read_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `member_activity_review_kind` ON `member_activity` (`kind`,`review_id`) WHERE "member_activity"."review_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_member_activity_at` ON `member_activity` (`at`);--> statement-breakpoint
CREATE INDEX `idx_member_activity_item` ON `member_activity` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_member_activity_progress` ON `member_activity` (`progress_id`);--> statement-breakpoint
ALTER TABLE `site_settings` ADD `names_on_shares` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `names_to_connections` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `display_name` text;