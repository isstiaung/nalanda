-- Custom migration (hand-written): date feed activity by when it happened, not when it was written
-- (ARCH.md §16 #40). Drizzle's DSL can't express triggers. Recreates 0007's two triggers; their
-- conditions are unchanged, and only `at` and the import rule are new.
--
-- 0007 left `at` to its default, now. So a Goodreads read from 2019, imported while a view was shared,
-- reached every follower as a finish from today, and its rating and review with it.
--
-- A finish is dated by completed_on when that's before today, and by now otherwise: a book marked
-- finished today, or with no date, is today's news. A rating or a review someone gives is news the day
-- they give it, even of a book read years ago, so outside an import both stay dated now.
--
-- Inside an import (a row in import_in_progress, which the import's own batch inserts first and
-- deletes last), none of it is news: all three kinds are dated by completed_on, clamped to now, and
-- a row with no usable completed_on records nothing. The receiver sorts by that date and keeps only
-- its retention window, so an old read lands in the past, or nowhere, instead of on top.
--
-- date() of anything that isn't a date is NULL, so a malformed completed_on counts as no date.

DROP TRIGGER `activity_log_items_ai`;
--> statement-breakpoint
DROP TRIGGER `activity_log_items_au`;
--> statement-breakpoint
CREATE TRIGGER `activity_log_items_ai` AFTER INSERT ON `items`
WHEN EXISTS (SELECT 1 FROM `connection_views`)
  AND (date(new.completed_on) IS NOT NULL OR NOT EXISTS (SELECT 1 FROM `import_in_progress`))
BEGIN
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`, `at`)
    SELECT new.id, 'reviewed',
      CASE WHEN EXISTS (SELECT 1 FROM `import_in_progress`) AND date(new.completed_on) < date('now')
        THEN datetime(new.completed_on) ELSE datetime('now') END
    WHERE trim(replace(coalesce(new.review, ''), char(13), ''), ' ' || char(9) || char(10)) <> '';
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`, `at`)
    SELECT new.id, 'rated',
      CASE WHEN EXISTS (SELECT 1 FROM `import_in_progress`) AND date(new.completed_on) < date('now')
        THEN datetime(new.completed_on) ELSE datetime('now') END
    WHERE coalesce(new.rating, 0) > 0;
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`, `at`)
    SELECT new.id, 'finished',
      CASE WHEN date(new.completed_on) < date('now') THEN datetime(new.completed_on) ELSE datetime('now') END
    WHERE new.status = 'completed';
END;
--> statement-breakpoint
CREATE TRIGGER `activity_log_items_au` AFTER UPDATE OF `review`, `rating`, `status`, `completed_on` ON `items`
WHEN EXISTS (SELECT 1 FROM `connection_views`)
  AND (date(new.completed_on) IS NOT NULL OR NOT EXISTS (SELECT 1 FROM `import_in_progress`))
BEGIN
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`, `at`)
    SELECT new.id, 'reviewed',
      CASE WHEN EXISTS (SELECT 1 FROM `import_in_progress`) AND date(new.completed_on) < date('now')
        THEN datetime(new.completed_on) ELSE datetime('now') END
    WHERE trim(replace(coalesce(new.review, ''), char(13), ''), ' ' || char(9) || char(10)) <> ''
      AND trim(replace(coalesce(new.review, ''), char(13), ''), ' ' || char(9) || char(10))
       <> trim(replace(coalesce(old.review, ''), char(13), ''), ' ' || char(9) || char(10));
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`, `at`)
    SELECT new.id, 'rated',
      CASE WHEN EXISTS (SELECT 1 FROM `import_in_progress`) AND date(new.completed_on) < date('now')
        THEN datetime(new.completed_on) ELSE datetime('now') END
    WHERE coalesce(new.rating, 0) > 0 AND new.rating IS NOT old.rating;
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`, `at`)
    SELECT new.id, 'finished',
      CASE WHEN date(new.completed_on) < date('now') THEN datetime(new.completed_on) ELSE datetime('now') END
    WHERE new.status = 'completed'
      AND (old.status IS NOT 'completed' OR new.completed_on IS NOT old.completed_on);
END;
