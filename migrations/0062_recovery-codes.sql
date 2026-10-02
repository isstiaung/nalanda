CREATE TABLE `recovery_codes` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`session_key` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`used_hash` text,
	`used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_codes_code_hash_unique` ON `recovery_codes` (`code_hash`);