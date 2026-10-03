CREATE TABLE `device_pairings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`user_id` integer,
	`session_key` text,
	`generation` integer,
	`code_hash` text,
	`poll_hash` text,
	`approve_hash` text,
	`match_digits` text,
	`device` text DEFAULT '' NOT NULL,
	`approved_at` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_pairings_code_hash_unique` ON `device_pairings` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_pairings_poll_hash_unique` ON `device_pairings` (`poll_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_pairings_approve_hash_unique` ON `device_pairings` (`approve_hash`);