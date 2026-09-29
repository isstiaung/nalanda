-- Custom migration (hand-written): each member's activity, for the per-person feed connections get while an admin
-- has switched names on (ARCH.md §16 #45). Drizzle's DSL can't express triggers. 0026 made the table.
--
-- Recorded always, whatever the switch: it decides at serve time which stream a connection pulls, the household's
-- activity_log (0007/0015/0021, untouched here) or this one. Nothing is written unless a connection view exists, as
-- for activity_log. Who did it isn't stored: a row points at its read, review or page, and the name is looked up
-- when a connection pulls, so moving a read, renaming or removing a member changes every later pull.
--
-- A start or a finish is recorded only as it happens — a read begun or ended today or yesterday (the server's day is
-- UTC), or with no date — and dated now, never by the read's own dates: a member's read dates never reach a connection.
-- A past read added later, or one an import brings, is no news and records nothing per person (the household's own
-- stream still records the finish, as ever). A rating or review is dated now; inside an import (a row in
-- import_in_progress) by the book's completed_on, as the household's are, and not at all without one (§16 #40). A
-- rating of 0 isn't one, as in the household's triggers.
--
-- One row per read and kind, and per review and kind: INSERT OR REPLACE gives a repeat a new id, so a connection
-- holding the old one learns from the removal check that its copy is out of date. Progress accumulates.

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
-- An instance already sharing a view starts the per-person log with its recent activity, as a first view does
-- (createConnectionView): the last 90 days, the newest 300 — ratings and reviews dated by their book's completed_on,
-- as the household's backfill dates them (§16 #40), and pages by their own time. Starts and finishes aren't backfilled:
-- dated by the read, they'd tell a connection each member's read dates.
INSERT INTO `member_activity` (`item_id`, `kind`, `at`, `read_id`, `review_id`, `progress_id`)
  SELECT `item_id`, `kind`, `at`, `read_id`, `review_id`, `progress_id` FROM (
    SELECT v.item_id, 'rated' AS kind, min(datetime(i.completed_on), datetime('now')) AS at, NULL AS read_id, v.id AS review_id, NULL AS progress_id
      FROM `reviews` v JOIN `items` i ON i.id = v.item_id
      WHERE coalesce(v.rating, 0) > 0 AND date(i.completed_on) > date('now', '-90 days')
    UNION ALL
    SELECT v.item_id, 'reviewed', min(datetime(i.completed_on), datetime('now')), NULL, v.id, NULL
      FROM `reviews` v JOIN `items` i ON i.id = v.item_id
      WHERE trim(replace(coalesce(v.review, ''), char(13), ''), ' ' || char(9) || char(10)) <> ''
        AND date(i.completed_on) > date('now', '-90 days')
    UNION ALL
    SELECT p.item_id, 'progress', datetime(p.at), NULL, NULL, p.id FROM `reading_progress` p
      WHERE datetime(p.at) > datetime('now', '-90 days')
        AND coalesce((SELECT `progress_to_connections` FROM `site_settings` WHERE `id` = 1), 1) = 1
    ORDER BY at DESC LIMIT 300
  )
  WHERE EXISTS (SELECT 1 FROM `connection_views`)
  ORDER BY at ASC;
