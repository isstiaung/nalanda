CREATE TABLE `display_fonts` (
	`locale` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`format` text NOT NULL,
	`name` text NOT NULL,
	`bytes` integer NOT NULL,
	`uploaded_at` text DEFAULT (datetime('now')) NOT NULL
);
