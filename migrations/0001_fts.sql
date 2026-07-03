-- Custom migration (hand-written): FTS5 index over items + sync triggers.
-- Drizzle's DSL can't express virtual tables/triggers — this file is the exception
-- allowed by CLAUDE.md. External-content table: no duplicated text storage.

CREATE VIRTUAL TABLE `items_fts` USING fts5(
  `title`, `creators`, `description`, `notes`,
  content='items', content_rowid='id'
);
--> statement-breakpoint
CREATE TRIGGER `items_fts_ai` AFTER INSERT ON `items` BEGIN
  INSERT INTO `items_fts`(rowid, title, creators, description, notes)
  VALUES (new.id, new.title, new.creators, new.description, new.notes);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_ad` AFTER DELETE ON `items` BEGIN
  INSERT INTO `items_fts`(`items_fts`, rowid, title, creators, description, notes)
  VALUES ('delete', old.id, old.title, old.creators, old.description, old.notes);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_au` AFTER UPDATE ON `items` BEGIN
  INSERT INTO `items_fts`(`items_fts`, rowid, title, creators, description, notes)
  VALUES ('delete', old.id, old.title, old.creators, old.description, old.notes);
  INSERT INTO `items_fts`(rowid, title, creators, description, notes)
  VALUES (new.id, new.title, new.creators, new.description, new.notes);
END;
