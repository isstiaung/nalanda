ALTER TABLE `items` ADD `language` text;--> statement-breakpoint
ALTER TABLE `items` ADD `original_title` text;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `language` text DEFAULT 'en' NOT NULL;