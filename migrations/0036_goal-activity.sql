-- Custom migration (hand-written): reading goals reach connections as per-person feed entries (ARCH.md §16 #49).
-- Drizzle's DSL can't express triggers, and drizzle-kit wraps a table rebuild in PRAGMA foreign_keys, which D1 doesn't
-- honour inside a migration (as 0019 found).
--
-- 1. member_activity is rebuilt so a goal entry can have no item. SQLite can't drop NOT NULL in place: create, copy,
--    drop, rename, re-index. Every row keeps its id, and AUTOINCREMENT's high-water mark is carried over: connections
--    hold these ids (offset by MEMBER_ACTIVITY_BASE) as cursors and in their removal checks, so an id handed out
--    before must never be handed out again — a copy alone would restart the sequence at the highest id still there,
--    reusing the ids of the newest entries deleted since. Nothing references member_activity. 0027's triggers name
--    it in their bodies, and SQLite checks every trigger when a table is renamed, so they are dropped first and made
--    again after, word for word.
-- 2. Two triggers on reads record a goal's milestones — halfway, reached — only as they happen: on the finish that
--    carries the count over the line, a book finished today or yesterday (the server's day is UTC) as 0027 judges a
--    per-person finish, never inside an import, and only while a connection view exists. A past read added later
--    crosses no line on anyone's feed. Dated now; they keep the finish that crossed (read_id, item_id), so a
--    milestone goes only to views that hold that book — where its finish is news already — and goes when that read
--    does. `goal_set` is recorded by the goal's own write (setGoal in src/db/queries.ts), never here.
--
-- 3. Instances that already have members keep the switches they had; new ones start with names and goals on (the
--    last statement).
--
-- The count is goalCountSql() in src/db/queries.ts, word for word: each finished read of a book by the goal's member
-- with its end date in the goal's year. A test holds the two together.

DROP TRIGGER `member_activity_reads_ai`;
--> statement-breakpoint
DROP TRIGGER `member_activity_reads_au`;
--> statement-breakpoint
DROP TRIGGER `member_activity_reviews_ai`;
--> statement-breakpoint
DROP TRIGGER `member_activity_reviews_au`;
--> statement-breakpoint
DROP TRIGGER `member_activity_progress_ai`;
--> statement-breakpoint
CREATE TABLE `member_activity_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer,
	`kind` text NOT NULL,
	`at` text DEFAULT (datetime('now')) NOT NULL,
	`read_id` integer,
	`review_id` integer,
	`progress_id` integer,
	`goal_id` integer,
	`goal_target` integer,
	`goal_count` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`read_id`) REFERENCES `reads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`progress_id`) REFERENCES `reading_progress`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`goal_id`) REFERENCES `reading_goals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `member_activity_new` (`id`, `item_id`, `kind`, `at`, `read_id`, `review_id`, `progress_id`)
SELECT `id`, `item_id`, `kind`, `at`, `read_id`, `review_id`, `progress_id` FROM `member_activity`;
--> statement-breakpoint
-- The high-water mark: when the newest entries were deleted since, a placeholder at the old sequence's value sets the
-- new table's sequence there, and goes again at once. Only sqlite_sequence is read, never written.
INSERT INTO `member_activity_new` (`id`, `kind`, `at`)
SELECT `seq`, 'goal_set', datetime('now') FROM `sqlite_sequence`
WHERE `name` = 'member_activity' AND `seq` > coalesce((SELECT max(`id`) FROM `member_activity`), 0);
--> statement-breakpoint
DELETE FROM `member_activity_new`
WHERE `goal_id` IS NULL AND `item_id` IS NULL AND `id` > coalesce((SELECT max(`id`) FROM `member_activity`), 0);
--> statement-breakpoint
DROP TABLE `member_activity`;
--> statement-breakpoint
ALTER TABLE `member_activity_new` RENAME TO `member_activity`;
--> statement-breakpoint
CREATE UNIQUE INDEX `member_activity_read_kind` ON `member_activity` (`kind`,`read_id`) WHERE "member_activity"."read_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `member_activity_review_kind` ON `member_activity` (`kind`,`review_id`) WHERE "member_activity"."review_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `member_activity_goal_kind` ON `member_activity` (`goal_id`,`kind`) WHERE "member_activity"."goal_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_member_activity_at` ON `member_activity` (`at`);
--> statement-breakpoint
CREATE INDEX `idx_member_activity_item` ON `member_activity` (`item_id`);
--> statement-breakpoint
CREATE INDEX `idx_member_activity_progress` ON `member_activity` (`progress_id`);
--> statement-breakpoint
-- A goal's milestones. `before` is the count without this finish: one less for a new finished read; for a read
-- changed to finished, or re-dated, one less unless it already counted toward the same year. Halfway is half the
-- target in whole books, rounded up; a finish that reaches the target is "reached", never also "halfway". INSERT OR
-- IGNORE: a milestone is recorded once per goal — changing a goal's target withdraws its milestones (setGoal). Made
-- before 0027's triggers are made again: SQLite fires the newest trigger first, so a finish's own entry is recorded
-- before the milestone it makes, and gets the lower id.
CREATE TRIGGER `member_goal_reads_ai` AFTER INSERT ON `reads`
WHEN new.status = 'completed' AND new.reader_id IS NOT NULL AND new.ended_on IS NOT NULL
  AND date(new.ended_on) >= date('now', '-1 day')
  AND EXISTS (SELECT 1 FROM `connection_views`) AND NOT EXISTS (SELECT 1 FROM `import_in_progress`)
  AND (SELECT `media_type` FROM `items` WHERE `id` = new.item_id) = 'book'
BEGIN
  INSERT OR IGNORE INTO `member_activity` (`item_id`, `kind`, `at`, `read_id`, `goal_id`, `goal_target`, `goal_count`)
    SELECT new.item_id, CASE WHEN c.n >= g.target THEN 'goal_reached' ELSE 'goal_halfway' END, datetime('now'), new.id,
      g.id, g.target, c.n
    FROM `reading_goals` g JOIN (SELECT g2.id AS goal, (SELECT count(*) FROM reads r JOIN items i ON i.id = r.item_id
  WHERE r.reader_id = g2.user_id AND r.status = 'completed' AND i.media_type = 'book'
    AND CAST(substr(r.ended_on, 1, 4) AS INTEGER) = g2.year) AS n
      FROM `reading_goals` g2 WHERE g2.user_id = new.reader_id) c ON c.goal = g.id
    WHERE g.user_id = new.reader_id AND g.year = CAST(substr(new.ended_on, 1, 4) AS INTEGER)
      AND ((c.n >= g.target AND c.n - 1 < g.target)
        OR (c.n < g.target AND c.n >= (g.target + 1) / 2 AND c.n - 1 < (g.target + 1) / 2));
END;
--> statement-breakpoint
CREATE TRIGGER `member_goal_reads_au` AFTER UPDATE OF `status`, `ended_on` ON `reads`
WHEN new.status = 'completed' AND new.reader_id IS NOT NULL AND new.ended_on IS NOT NULL
  AND date(new.ended_on) >= date('now', '-1 day')
  AND (old.status IS NOT 'completed' OR new.ended_on IS NOT old.ended_on)
  AND EXISTS (SELECT 1 FROM `connection_views`) AND NOT EXISTS (SELECT 1 FROM `import_in_progress`)
  AND (SELECT `media_type` FROM `items` WHERE `id` = new.item_id) = 'book'
BEGIN
  INSERT OR IGNORE INTO `member_activity` (`item_id`, `kind`, `at`, `read_id`, `goal_id`, `goal_target`, `goal_count`)
    SELECT new.item_id, CASE WHEN c.n >= g.target THEN 'goal_reached' ELSE 'goal_halfway' END, datetime('now'), new.id,
      g.id, g.target, c.n
    FROM `reading_goals` g JOIN (SELECT g2.id AS goal, (SELECT count(*) FROM reads r JOIN items i ON i.id = r.item_id
  WHERE r.reader_id = g2.user_id AND r.status = 'completed' AND i.media_type = 'book'
    AND CAST(substr(r.ended_on, 1, 4) AS INTEGER) = g2.year) AS n,
      CASE WHEN old.status = 'completed' AND old.reader_id IS new.reader_id
        AND CAST(substr(old.ended_on, 1, 4) AS INTEGER) = g2.year THEN 1 ELSE 0 END AS counted
      FROM `reading_goals` g2 WHERE g2.user_id = new.reader_id) c ON c.goal = g.id
    WHERE g.user_id = new.reader_id AND g.year = CAST(substr(new.ended_on, 1, 4) AS INTEGER)
      AND ((c.n >= g.target AND c.n - 1 + c.counted < g.target)
        OR (c.n < g.target AND c.n >= (g.target + 1) / 2 AND c.n - 1 + c.counted < (g.target + 1) / 2));
END;
--> statement-breakpoint
-- 0027's triggers, word for word.
CREATE TRIGGER `member_activity_reads_ai` AFTER INSERT ON `reads`
WHEN EXISTS (SELECT 1 FROM `connection_views`) AND NOT EXISTS (SELECT 1 FROM `import_in_progress`)
BEGIN
  INSERT OR REPLACE INTO `member_activity` (`item_id`, `kind`, `at`, `read_id`)
    SELECT new.item_id, 'finished', datetime('now'), new.id
    WHERE new.status = 'completed' AND (new.ended_on IS NULL OR date(new.ended_on) >= date('now', '-1 day'));
  INSERT OR REPLACE INTO `member_activity` (`item_id`, `kind`, `at`, `read_id`)
    SELECT new.item_id, 'started', datetime('now'), new.id
    WHERE new.status = 'in_progress' AND (new.began_on IS NULL OR date(new.began_on) >= date('now', '-1 day'));
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_reads_au` AFTER UPDATE OF `status`, `ended_on` ON `reads`
WHEN EXISTS (SELECT 1 FROM `connection_views`) AND NOT EXISTS (SELECT 1 FROM `import_in_progress`)
BEGIN
  INSERT OR REPLACE INTO `member_activity` (`item_id`, `kind`, `at`, `read_id`)
    SELECT new.item_id, 'finished', datetime('now'), new.id
    WHERE new.status = 'completed' AND (old.status IS NOT 'completed' OR new.ended_on IS NOT old.ended_on)
      AND (new.ended_on IS NULL OR date(new.ended_on) >= date('now', '-1 day'));
  INSERT OR REPLACE INTO `member_activity` (`item_id`, `kind`, `at`, `read_id`)
    SELECT new.item_id, 'started', datetime('now'), new.id
    WHERE new.status = 'in_progress' AND old.status IS NOT 'in_progress'
      AND (new.began_on IS NULL OR date(new.began_on) >= date('now', '-1 day'));
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_reviews_ai` AFTER INSERT ON `reviews`
WHEN EXISTS (SELECT 1 FROM `connection_views`)
  AND (date((SELECT `completed_on` FROM `items` WHERE `id` = new.item_id)) IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM `import_in_progress`))
BEGIN
  INSERT OR REPLACE INTO `member_activity` (`item_id`, `kind`, `at`, `review_id`)
    SELECT new.item_id, 'rated',
      CASE WHEN EXISTS (SELECT 1 FROM `import_in_progress`) AND date(i.completed_on) < date('now')
        THEN datetime(i.completed_on) ELSE datetime('now') END, new.id
    FROM `items` i WHERE i.id = new.item_id AND coalesce(new.rating, 0) > 0;
  INSERT OR REPLACE INTO `member_activity` (`item_id`, `kind`, `at`, `review_id`)
    SELECT new.item_id, 'reviewed',
      CASE WHEN EXISTS (SELECT 1 FROM `import_in_progress`) AND date(i.completed_on) < date('now')
        THEN datetime(i.completed_on) ELSE datetime('now') END, new.id
    FROM `items` i WHERE i.id = new.item_id
      AND trim(replace(coalesce(new.review, ''), char(13), ''), ' ' || char(9) || char(10)) <> '';
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_reviews_au` AFTER UPDATE OF `rating`, `review` ON `reviews`
WHEN EXISTS (SELECT 1 FROM `connection_views`)
  AND (date((SELECT `completed_on` FROM `items` WHERE `id` = new.item_id)) IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM `import_in_progress`))
BEGIN
  INSERT OR REPLACE INTO `member_activity` (`item_id`, `kind`, `at`, `review_id`)
    SELECT new.item_id, 'rated',
      CASE WHEN EXISTS (SELECT 1 FROM `import_in_progress`) AND date(i.completed_on) < date('now')
        THEN datetime(i.completed_on) ELSE datetime('now') END, new.id
    FROM `items` i WHERE i.id = new.item_id AND coalesce(new.rating, 0) > 0 AND new.rating IS NOT old.rating;
  INSERT OR REPLACE INTO `member_activity` (`item_id`, `kind`, `at`, `review_id`)
    SELECT new.item_id, 'reviewed',
      CASE WHEN EXISTS (SELECT 1 FROM `import_in_progress`) AND date(i.completed_on) < date('now')
        THEN datetime(i.completed_on) ELSE datetime('now') END, new.id
    FROM `items` i WHERE i.id = new.item_id
      AND trim(replace(coalesce(new.review, ''), char(13), ''), ' ' || char(9) || char(10)) <> ''
      AND trim(replace(coalesce(new.review, ''), char(13), ''), ' ' || char(9) || char(10))
       <> trim(replace(coalesce(old.review, ''), char(13), ''), ' ' || char(9) || char(10));
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_progress_ai` AFTER INSERT ON `reading_progress`
WHEN EXISTS (SELECT 1 FROM `connection_views`)
  AND coalesce((SELECT `progress_to_connections` FROM `site_settings` WHERE `id` = 1), 1) = 1
BEGIN
  INSERT INTO `member_activity` (`item_id`, `kind`, `at`, `progress_id`) VALUES (new.item_id, 'progress', new.at, new.id);
END;
--> statement-breakpoint
-- New defaults, same instance (§16 #49). From this version a new instance starts with names on share pages, names to
-- connections and goals to connections all on — the code's defaults, used only while there's no site_settings row.
-- An instance that already has members keeps exactly what it has: with a row it keeps its row (0028 gave the new
-- goals column 0, off); without one it had been running on the old defaults, so this writes them down — progress on
-- share pages off, progress to connections on, names off, goals off. A new instance has no members when it migrates,
-- so it gets no row, and the new defaults.
INSERT OR IGNORE INTO `site_settings` (`id`, `progress_on_shares`, `progress_to_connections`, `names_on_shares`, `names_to_connections`, `goals_to_connections`)
SELECT 1, 0, 1, 0, 0, 0 WHERE EXISTS (SELECT 1 FROM `users`);
