-- Custom migration (hand-written): item history (ARCH.md §16 #84). One AFTER UPDATE trigger on items records each change
-- to one of the item's own fields — never the household's reading summary (status, dates, read count, rating, review),
-- which reads and reviews carry with their people already — as one row per changed column: the value before and
-- after, kept to 200 characters, the shelf and the series by name rather than id, the cover as 'a cover' or nothing
-- (keys are random and the old object is gone), a whole series number without a trailing .0, and who made the change from the `acting` row the writing batch set
-- first and clears last (the import_in_progress pattern, 0021) — nobody when no batch said. Firing on every path that
-- updates items (the edit form, the Holding toggle, bulk edit, a cover, Refresh from BGG or Discogs, an import), so
-- history can't miss a path, and admins read it on the item page, rows older than 90 days purged as they read.
-- The tables are the generated migration just before this one (0049).
CREATE TRIGGER `item_history_au` AFTER UPDATE OF `title`, `creators`, `publisher`, `published`, `description`, `length`, `isbn13`, `isbn10_upc`, `media_type`, `library_id`, `copies`, `location`, `notes`, `language`, `original_title`, `cover_key`, `formats`, `series_id`, `series_number`, `purchase_price`, `purchase_currency`, `media_condition`, `sleeve_condition`, `details` ON `items`
BEGIN
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'title', substr(old.title, 1, 200), substr(new.title, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.title IS NOT new.title;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'creators', substr(old.creators, 1, 200), substr(new.creators, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.creators IS NOT new.creators;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'publisher', substr(old.publisher, 1, 200), substr(new.publisher, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.publisher IS NOT new.publisher;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'published', substr(old.published, 1, 200), substr(new.published, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.published IS NOT new.published;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'description', substr(old.description, 1, 200), substr(new.description, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.description IS NOT new.description;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'length', substr(old.length, 1, 200), substr(new.length, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.length IS NOT new.length;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'isbn13', substr(old.isbn13, 1, 200), substr(new.isbn13, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.isbn13 IS NOT new.isbn13;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'isbn10_upc', substr(old.isbn10_upc, 1, 200), substr(new.isbn10_upc, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.isbn10_upc IS NOT new.isbn10_upc;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'media_type', substr(old.media_type, 1, 200), substr(new.media_type, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.media_type IS NOT new.media_type;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'library_id', (SELECT name FROM libraries WHERE id = old.library_id), (SELECT name FROM libraries WHERE id = new.library_id),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.library_id IS NOT new.library_id;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'copies', substr(old.copies, 1, 200), substr(new.copies, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.copies IS NOT new.copies;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'location', substr(old.location, 1, 200), substr(new.location, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.location IS NOT new.location;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'notes', substr(old.notes, 1, 200), substr(new.notes, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.notes IS NOT new.notes;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'language', substr(old.language, 1, 200), substr(new.language, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.language IS NOT new.language;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'original_title', substr(old.original_title, 1, 200), substr(new.original_title, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.original_title IS NOT new.original_title;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'cover_key', CASE WHEN old.cover_key IS NULL THEN NULL ELSE 'a cover' END, CASE WHEN new.cover_key IS NULL THEN NULL ELSE 'a cover' END,
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.cover_key IS NOT new.cover_key;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'formats', substr(old.formats, 1, 200), substr(new.formats, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.formats IS NOT new.formats;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'series_id', (SELECT name FROM series WHERE id = old.series_id), (SELECT name FROM series WHERE id = new.series_id),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.series_id IS NOT new.series_id;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'series_number', CASE WHEN old.series_number IS NULL THEN NULL WHEN old.series_number = CAST(old.series_number AS INTEGER) THEN CAST(CAST(old.series_number AS INTEGER) AS TEXT) ELSE CAST(old.series_number AS TEXT) END, CASE WHEN new.series_number IS NULL THEN NULL WHEN new.series_number = CAST(new.series_number AS INTEGER) THEN CAST(CAST(new.series_number AS INTEGER) AS TEXT) ELSE CAST(new.series_number AS TEXT) END,
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.series_number IS NOT new.series_number;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'purchase_price', substr(old.purchase_price, 1, 200), substr(new.purchase_price, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.purchase_price IS NOT new.purchase_price;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'purchase_currency', substr(old.purchase_currency, 1, 200), substr(new.purchase_currency, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.purchase_currency IS NOT new.purchase_currency;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'media_condition', substr(old.media_condition, 1, 200), substr(new.media_condition, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.media_condition IS NOT new.media_condition;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'sleeve_condition', substr(old.sleeve_condition, 1, 200), substr(new.sleeve_condition, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.sleeve_condition IS NOT new.sleeve_condition;
  INSERT INTO `item_history` (`item_id`, `field`, `before`, `after`, `changed_by`, `changed_key`)
    SELECT new.id, 'details', substr(old.details, 1, 200), substr(new.details, 1, 200),
           (SELECT user_id FROM `acting` WHERE id = 1), (SELECT session_key FROM `acting` WHERE id = 1)
    WHERE old.details IS NOT new.details;
END;
