DROP INDEX `activity_log_item_kind`;--> statement-breakpoint
ALTER TABLE `activity_log` ADD `progress_id` integer REFERENCES reading_progress(id);--> statement-breakpoint
CREATE INDEX `idx_activity_log_progress` ON `activity_log` (`progress_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_log_item_kind` ON `activity_log` (`item_id`,`kind`) WHERE "activity_log"."kind" <> 'progress';--> statement-breakpoint
ALTER TABLE `site_settings` ADD `progress_to_connections` integer DEFAULT true NOT NULL;