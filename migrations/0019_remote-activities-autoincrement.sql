-- Custom migration (hand-written): remote_activities.id becomes AUTOINCREMENT (ARCH.md §16 #36).
--
-- A plain INTEGER PRIMARY KEY reuses the highest id once that row is deleted. When a connection withdrew its
-- newest entry, the next one to arrive took the same id, fell at or below a reader's feed_seen_id, and the
-- Feed badge undercounted. AUTOINCREMENT never hands an id out twice.
--
-- SQLite can't change a primary key in place, so the table is rebuilt: create, copy, drop, rename,
-- re-index. Hand-written rather than generated because drizzle-kit wraps rebuilds in PRAGMA foreign_keys,
-- which D1 doesn't honour inside a migration. Nothing references remote_activities and no trigger touches
-- it, so dropping the old table is safe with foreign keys enforced; the rows copied already satisfy their
-- own reference to feed_subscriptions. The copy keeps every id, and sqlite_sequence starts from the highest.

CREATE TABLE `remote_activities_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscription_id` integer NOT NULL,
	`remote_id` integer NOT NULL,
	`item_remote_id` integer NOT NULL,
	`kind` text NOT NULL,
	`published_at` text NOT NULL,
	`item` text NOT NULL,
	`bytes` integer NOT NULL,
	`received_at` text DEFAULT (datetime('now')) NOT NULL,
	`item_stamp` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `feed_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `remote_activities_new`
  (`id`, `subscription_id`, `remote_id`, `item_remote_id`, `kind`, `published_at`, `item`, `bytes`, `received_at`, `item_stamp`)
SELECT `id`, `subscription_id`, `remote_id`, `item_remote_id`, `kind`, `published_at`, `item`, `bytes`, `received_at`, `item_stamp`
FROM `remote_activities`;
--> statement-breakpoint
DROP TABLE `remote_activities`;
--> statement-breakpoint
ALTER TABLE `remote_activities_new` RENAME TO `remote_activities`;
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_activities_subscription_remote` ON `remote_activities` (`subscription_id`,`remote_id`);
--> statement-breakpoint
CREATE INDEX `idx_remote_activities_published` ON `remote_activities` (`published_at`);
--> statement-breakpoint
CREATE INDEX `idx_remote_activities_item` ON `remote_activities` (`item_remote_id`);
