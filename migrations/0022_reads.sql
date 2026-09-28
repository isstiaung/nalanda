CREATE TABLE `reads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`status` text NOT NULL,
	`began_on` text,
	`ended_on` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_reads_item` ON `reads` (`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reads_one_open` ON `reads` (`item_id`) WHERE "reads"."status" = 'in_progress';--> statement-breakpoint
ALTER TABLE `items` ADD `read_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `rereading` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `reading_progress` ADD `read_id` integer REFERENCES reads(id);--> statement-breakpoint
CREATE INDEX `idx_reading_progress_read` ON `reading_progress` (`read_id`);