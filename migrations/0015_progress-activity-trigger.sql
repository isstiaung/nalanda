-- Custom migration (hand-written): a reading-progress update becomes a feed entry of its own
-- (ARCH.md §16 #35). Drizzle's DSL can't express triggers.
--
-- Unlike 0007's triggers this one never replaces: every update is a separate entry, pointing at its
-- reading_progress row so it carries that update's page. 0014 made activity_log's (item, kind)
-- uniqueness partial so these can accumulate while reviews, ratings and finishes still collapse.
-- deleteProgress() removes an update's entry before the update itself.
--
-- Same guard as 0007 — nothing is written unless a connection view exists — plus the household's
-- choice, site_settings.progress_to_connections. A missing settings row means the default, on.
-- Only books have progress; the route enforces that, so the trigger doesn't repeat it.

CREATE TRIGGER `activity_log_progress_ai` AFTER INSERT ON `reading_progress`
WHEN EXISTS (SELECT 1 FROM `connection_views`)
  AND coalesce((SELECT `progress_to_connections` FROM `site_settings` WHERE `id` = 1), 1) = 1
BEGIN
  INSERT INTO `activity_log` (`item_id`, `kind`, `at`, `progress_id`)
    VALUES (new.item_id, 'progress', new.at, new.id);
END;
