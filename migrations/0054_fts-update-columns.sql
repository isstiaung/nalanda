-- Custom migration (hand-written): the search index's update trigger fires only when an indexed column changes.
--
-- `items_fts_au` (0045) was `AFTER UPDATE ON items` with no column list, so every UPDATE of an item — a
-- refreshReadState() over items whose reading hadn't moved, a bulk move of a shelf, a page recorded — deleted and
-- re-inserted its index row: two rows written for nothing, three times the rows of the update itself, against the
-- free tier's rows-written-a-day. Recreated here as `AFTER UPDATE OF` the six columns the index holds, with the same
-- name and the same body. The index's content and shape don't change, so there is nothing to rebuild and no data is
-- touched; the insert and delete triggers (0045) stay as they are.

DROP TRIGGER IF EXISTS `items_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `items_fts_au` AFTER UPDATE OF `title`, `creators`, `description`, `notes`, `location`, `original_title` ON `items` BEGIN
  INSERT INTO `items_fts`(`items_fts`, rowid, title, creators, description, notes, location, original_title)
  VALUES ('delete', old.id, old.title, old.creators, old.description, old.notes, old.location, old.original_title);
  INSERT INTO `items_fts`(rowid, title, creators, description, notes, location, original_title)
  VALUES (new.id, new.title, new.creators, new.description, new.notes, new.location, new.original_title);
END;
