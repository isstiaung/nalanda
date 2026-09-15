CREATE TABLE `borrow_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`activity_id` text NOT NULL,
	`connection_id` integer NOT NULL,
	`incoming` integer NOT NULL,
	`our_item_id` integer,
	`their_item_id` integer,
	`their_view_id` integer,
	`item_title` text NOT NULL,
	`cover_key` text,
	`requester_name` text NOT NULL,
	`requester_id` integer,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_on` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`responded_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`our_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `borrow_requests_activity_id_unique` ON `borrow_requests` (`activity_id`);--> statement-breakpoint
CREATE INDEX `idx_borrow_requests_connection` ON `borrow_requests` (`connection_id`,`status`);--> statement-breakpoint
CREATE TABLE `borrowed_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`request_activity_id` text NOT NULL,
	`their_item_id` integer NOT NULL,
	`title` text NOT NULL,
	`cover_key` text,
	`borrowed_on` text NOT NULL,
	`due_on` text,
	`returned_on` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `borrowed_items_request_activity_id_unique` ON `borrowed_items` (`request_activity_id`);--> statement-breakpoint
CREATE TABLE `connection_loans` (
	`loan_id` integer PRIMARY KEY NOT NULL,
	`connection_id` integer NOT NULL,
	`request_id` integer,
	`request_activity_id` text NOT NULL,
	FOREIGN KEY (`loan_id`) REFERENCES `loans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`request_id`) REFERENCES `borrow_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `outbox` ADD `attempted_at` text;