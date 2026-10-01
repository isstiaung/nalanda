-- Custom migration (hand-written): the search index gains items.original_title (ARCH.md §16 #76), the title a work
-- was first published under, in whatever script it was typed, so search finds it as written. The column itself is
-- the generated migration just before this one; this must run after it, since the rebuild below reads it.
--
-- As 0032 did for location: FTS5 can't add a column to a virtual table, so the index and its three sync triggers are
-- dropped and made again with the same names, the same external-content shape and the same trigger bodies, plus
-- `original_title`. The index holds nothing of its own — content='items' — so dropping it loses nothing, and
-- 'rebuild' refills it from items. Searching stays authenticated (/search); share pages and connections never query it.

DROP TRIGGER IF EXISTS `items_fts_ai`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `items_fts_ad`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `items_fts_au`;
--> statement-breakpoint
DROP TABLE IF EXISTS `items_fts`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `items_fts` USING fts5(
  `title`, `creators`, `description`, `notes`, `location`, `original_title`,
  content='items', content_rowid='id'
);
--> statement-breakpoint
CREATE TRIGGER `items_fts_ai` AFTER INSERT ON `items` BEGIN
  INSERT INTO `items_fts`(rowid, title, creators, description, notes, location, original_title)
  VALUES (new.id, new.title, new.creators, new.description, new.notes, new.location, new.original_title);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_ad` AFTER DELETE ON `items` BEGIN
  INSERT INTO `items_fts`(`items_fts`, rowid, title, creators, description, notes, location, original_title)
  VALUES ('delete', old.id, old.title, old.creators, old.description, old.notes, old.location, old.original_title);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_au` AFTER UPDATE ON `items` BEGIN
  INSERT INTO `items_fts`(`items_fts`, rowid, title, creators, description, notes, location, original_title)
  VALUES ('delete', old.id, old.title, old.creators, old.description, old.notes, old.location, old.original_title);
  INSERT INTO `items_fts`(rowid, title, creators, description, notes, location, original_title)
  VALUES (new.id, new.title, new.creators, new.description, new.notes, new.location, new.original_title);
END;
--> statement-breakpoint
INSERT INTO `items_fts`(`items_fts`) VALUES ('rebuild');
