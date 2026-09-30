CREATE TABLE `recommendations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`activity_id` text NOT NULL,
	`connection_id` integer NOT NULL,
	`incoming` integer NOT NULL,
	`our_item_id` integer,
	`sender_id` integer,
	`their_item_id` integer,
	`their_item_stamp` text,
	`their_view_id` integer,
	`media_type` text NOT NULL,
	`title` text NOT NULL,
	`creators` text,
	`published` text,
	`cover_key` text,
	`identifiers` text DEFAULT '{}' NOT NULL,
	`recommender` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'open' NOT NULL,
	`handled_by` integer,
	`wanted_item_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`handled_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`our_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`handled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`wanted_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recommendations_activity_id_unique` ON `recommendations` (`activity_id`);--> statement-breakpoint
CREATE INDEX `idx_recommendations_connection` ON `recommendations` (`connection_id`,`incoming`,`status`);--> statement-breakpoint
CREATE INDEX `idx_recommendations_our_item` ON `recommendations` (`our_item_id`);