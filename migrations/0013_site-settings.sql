CREATE TABLE `site_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`progress_on_shares` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
