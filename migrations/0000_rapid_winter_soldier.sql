CREATE TABLE `item_tags` (
	`item_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`item_id`, `tag_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` integer PRIMARY KEY NOT NULL,
	`library_id` integer NOT NULL,
	`media_type` text DEFAULT 'book' NOT NULL,
	`title` text NOT NULL,
	`creators` text,
	`isbn13` text,
	`isbn10_upc` text,
	`publisher` text,
	`published` text,
	`description` text,
	`length` integer,
	`cover_key` text,
	`status` text DEFAULT 'not_started' NOT NULL,
	`rating` integer,
	`review` text,
	`notes` text,
	`copies` integer DEFAULT 1 NOT NULL,
	`began_on` text,
	`completed_on` text,
	`details` text DEFAULT '{}' NOT NULL,
	`added_by` integer,
	`added_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_items_library` ON `items` (`library_id`);--> statement-breakpoint
CREATE INDEX `idx_items_isbn13` ON `items` (`isbn13`);--> statement-breakpoint
CREATE TABLE `libraries` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`share_token` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_share_token_unique` ON `libraries` (`share_token`);--> statement-breakpoint
CREATE TABLE `loans` (
	`id` integer PRIMARY KEY NOT NULL,
	`item_id` integer NOT NULL,
	`borrower` text NOT NULL,
	`contact` text,
	`loaned_on` text DEFAULT (date('now')) NOT NULL,
	`due_on` text,
	`returned_on` text,
	`note` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_loans_item` ON `loans` (`item_id`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`ip` text NOT NULL,
	`attempted_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`must_change_password` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);