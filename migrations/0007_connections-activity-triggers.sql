-- Custom migration (hand-written): record feed activity for connections between instances
-- (docs/proposals/connections.md §8). Drizzle's DSL can't express triggers.
--
-- One row per item and kind. A repeat — an edited review, a new rating, a re-read — replaces the
-- row under a new id, so the log never holds more than three rows per item, and a connection
-- holding the old id learns from the removal check that its copy is out of date.
--
-- A review is compared as connections see it: carriage returns dropped and surrounding whitespace
-- trimmed. A browser submits an untouched review with CRLF line endings, and that isn't an edit.
-- src/db/federation.ts applies the same normalisation.
--
-- Nothing is written unless at least one connection view exists: a household that never shares
-- anything with connections records nothing, exactly as before.

CREATE TRIGGER `activity_log_items_ai` AFTER INSERT ON `items`
WHEN EXISTS (SELECT 1 FROM `connection_views`)
BEGIN
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`)
    SELECT new.id, 'reviewed'
    WHERE trim(replace(coalesce(new.review, ''), char(13), ''), ' ' || char(9) || char(10)) <> '';
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`)
    SELECT new.id, 'rated' WHERE coalesce(new.rating, 0) > 0;
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`)
    SELECT new.id, 'finished' WHERE new.status = 'completed';
END;
--> statement-breakpoint
CREATE TRIGGER `activity_log_items_au` AFTER UPDATE OF `review`, `rating`, `status`, `completed_on` ON `items`
WHEN EXISTS (SELECT 1 FROM `connection_views`)
BEGIN
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`)
    SELECT new.id, 'reviewed'
    WHERE trim(replace(coalesce(new.review, ''), char(13), ''), ' ' || char(9) || char(10)) <> ''
      AND trim(replace(coalesce(new.review, ''), char(13), ''), ' ' || char(9) || char(10))
       <> trim(replace(coalesce(old.review, ''), char(13), ''), ' ' || char(9) || char(10));
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`)
    SELECT new.id, 'rated' WHERE coalesce(new.rating, 0) > 0 AND new.rating IS NOT old.rating;
  INSERT OR REPLACE INTO `activity_log` (`item_id`, `kind`)
    SELECT new.id, 'finished' WHERE new.status = 'completed'
      AND (old.status IS NOT 'completed' OR new.completed_on IS NOT old.completed_on);
END;
