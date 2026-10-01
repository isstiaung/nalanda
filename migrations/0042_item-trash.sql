CREATE TABLE `trash` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`library_id` integer,
	`library_name` text,
	`media_type` text NOT NULL,
	`title` text NOT NULL,
	`creators` text,
	`cover_key` text,
	`payload` text NOT NULL,
	`deleted_at` text DEFAULT (datetime('now')) NOT NULL,
	`deleted_by` integer,
	`deleted_by_key` text
);
--> statement-breakpoint
CREATE INDEX `idx_trash_deleted` ON `trash` (`deleted_at`);