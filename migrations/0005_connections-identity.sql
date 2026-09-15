CREATE TABLE `connection_invites` (
	`id` integer PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_invites_token_hash_unique` ON `connection_invites` (`token_hash`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` integer PRIMARY KEY NOT NULL,
	`base_url` text NOT NULL,
	`household_name` text NOT NULL,
	`public_key` text NOT NULL,
	`status` text NOT NULL,
	`invite_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`confirmed_at` text,
	FOREIGN KEY (`invite_id`) REFERENCES `connection_invites`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_base_url_unique` ON `connections` (`base_url`);--> statement-breakpoint
CREATE TABLE `federation_seen` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`seen_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `federation_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`household_name` text NOT NULL,
	`base_url` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
