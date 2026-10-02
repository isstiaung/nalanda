CREATE TABLE `account_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`session_key` text NOT NULL,
	`purpose` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_links_token_hash_unique` ON `account_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_account_links_user` ON `account_links` (`user_id`);