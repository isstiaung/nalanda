CREATE TABLE `borrows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`lender` text NOT NULL,
	`contact` text,
	`borrowed_on` text NOT NULL,
	`due_on` text,
	`returned_on` text,
	`note` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_borrows_item` ON `borrows` (`item_id`);