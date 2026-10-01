CREATE INDEX `idx_item_tags_tag` ON `item_tags` (`tag_id`);--> statement-breakpoint
CREATE INDEX `idx_items_library_added` ON `items` (`library_id`,`added_at`);--> statement-breakpoint
CREATE INDEX `idx_items_library_title` ON `items` (`library_id`,`title`);--> statement-breakpoint
CREATE INDEX `idx_items_added` ON `items` (`added_at`);--> statement-breakpoint
CREATE INDEX `idx_items_library_type` ON `items` (`library_id`,`media_type`);--> statement-breakpoint
CREATE INDEX `idx_items_paid` ON `items` (`library_id`,`purchase_currency`,`purchase_price`) WHERE "items"."purchase_price" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_reads_status_ended` ON `reads` (`status`,`ended_on`);