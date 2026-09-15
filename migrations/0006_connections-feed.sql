CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`kind` text NOT NULL,
	`at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_log_item_kind` ON `activity_log` (`item_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_activity_log_at` ON `activity_log` (`at`);--> statement-breakpoint
CREATE TABLE `connection_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`library_id` integer,
	`media_type` text,
	`status` text,
	`owned` integer,
	`sort` text DEFAULT 'title' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `feed_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`view_id` integer NOT NULL,
	`view_name` text NOT NULL,
	`interval_minutes` integer NOT NULL,
	`retention_days` integer NOT NULL,
	`max_entries` integer NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`last_pulled_at` text,
	`last_error` text,
	`removed_unseen` integer DEFAULT 0 NOT NULL,
	`gone_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feed_subscriptions_connection_view` ON `feed_subscriptions` (`connection_id`,`view_id`);--> statement-breakpoint
CREATE TABLE `remote_activities` (
	`id` integer PRIMARY KEY NOT NULL,
	`subscription_id` integer NOT NULL,
	`remote_id` integer NOT NULL,
	`item_remote_id` integer NOT NULL,
	`kind` text NOT NULL,
	`published_at` text NOT NULL,
	`item` text NOT NULL,
	`bytes` integer NOT NULL,
	`received_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `feed_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_activities_subscription_remote` ON `remote_activities` (`subscription_id`,`remote_id`);--> statement-breakpoint
CREATE INDEX `idx_remote_activities_published` ON `remote_activities` (`published_at`);--> statement-breakpoint
CREATE INDEX `idx_remote_activities_item` ON `remote_activities` (`item_remote_id`);--> statement-breakpoint
ALTER TABLE `connection_push_counts` ADD `feed_entries` integer DEFAULT 0 NOT NULL;