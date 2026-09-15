CREATE TABLE `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`activity_id` text NOT NULL,
	`connection_id` integer NOT NULL,
	`our_item_id` integer,
	`their_item_id` integer,
	`from_us` integer NOT NULL,
	`author_name` text NOT NULL,
	`author_id` integer,
	`body` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`our_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comments_activity_id_unique` ON `comments` (`activity_id`);--> statement-breakpoint
CREATE INDEX `idx_comments_our_item` ON `comments` (`our_item_id`);--> statement-breakpoint
CREATE INDEX `idx_comments_their_item` ON `comments` (`connection_id`,`their_item_id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`activity_id` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_activity_id_unique` ON `outbox` (`activity_id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_connection` ON `outbox` (`connection_id`,`id`);--> statement-breakpoint
ALTER TABLE `connections` ADD `outbox_cursor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `outbox_pulled_at` text;