-- Custom migration (hand-written): each item's reading so far, as reads (ARCH.md §16 #41). Drizzle's DSL can't
-- express the data. 0022 made the table and the columns; this fills them from what items say today.
--
-- One status and two dates become reads by the rules in readsFromColumns() (src/lib/reads.ts), which imports use
-- too, and test/reads-migration.spec.ts proves the two agree:
--   completed, abandoned        one read, with both dates
--   in progress                 one open read; with a completion date as well, a finished read before it too —
--                               the book was finished and is being read again (the start date goes with the
--                               read it precedes)
--   not started, with a date    a completion date is a finished read, a start date alone an open one
-- Then Goodreads' Read Count, kept in details since the import, tops the finished reads up with undated ones
-- (at most 100 reads an item) and leaves details: it lives in read_count now, and it no longer shows as a
-- "read count" line on share pages and connections' item pages. A count that isn't a whole number stays.
--
-- Pages recorded so far belong to each item's current read. Then every item with reads is refreshed with the
-- same SET as refreshReadState() in src/db/queries.ts. For every item whose status and dates were already
-- consistent that changes nothing but read_count and rereading. A book not started that a date or a count says
-- was read becomes Completed, and one in progress that was finished before becomes Completed and re-reading.
--
-- All of it sits between the rows that set and clear import_in_progress, so the activity triggers (0021) date
-- what changed by completed_on, clamped to now, and record nothing without a date: none of this is news.

INSERT INTO `import_in_progress` (`id`) VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO `reads` (`item_id`, `status`, `began_on`, `ended_on`)
  SELECT `id`, `status`, nullif(trim(`began_on`), ''), nullif(trim(`completed_on`), '')
  FROM `items` WHERE `status` IN ('completed', 'abandoned') ORDER BY `id`;
--> statement-breakpoint
INSERT INTO `reads` (`item_id`, `status`, `began_on`, `ended_on`)
  SELECT `id`, 'completed',
    CASE WHEN nullif(trim(`began_on`), '') <= trim(`completed_on`) THEN trim(`began_on`) END,
    trim(`completed_on`)
  FROM `items` WHERE `status` = 'in_progress' AND nullif(trim(`completed_on`), '') IS NOT NULL ORDER BY `id`;
--> statement-breakpoint
INSERT INTO `reads` (`item_id`, `status`, `began_on`)
  SELECT `id`, 'in_progress',
    CASE WHEN nullif(trim(`completed_on`), '') IS NULL OR nullif(trim(`began_on`), '') > trim(`completed_on`)
      THEN nullif(trim(`began_on`), '') END
  FROM `items` WHERE `status` = 'in_progress' ORDER BY `id`;
--> statement-breakpoint
INSERT INTO `reads` (`item_id`, `status`, `began_on`, `ended_on`)
  SELECT `id`,
    CASE WHEN nullif(trim(`completed_on`), '') IS NOT NULL THEN 'completed' ELSE 'in_progress' END,
    nullif(trim(`began_on`), ''), nullif(trim(`completed_on`), '')
  FROM `items`
  WHERE `status` = 'not_started' AND (nullif(trim(`completed_on`), '') IS NOT NULL OR nullif(trim(`began_on`), '') IS NOT NULL)
  ORDER BY `id`;
--> statement-breakpoint
INSERT INTO `reads` (`item_id`, `status`)
  WITH RECURSIVE `n`(`k`) AS (SELECT 1 UNION ALL SELECT `k` + 1 FROM `n` WHERE `k` < 100),
  `counted` AS (
    SELECT `i`.`id` AS `item_id`,
      min(100, CAST(trim(json_extract(`i`.`details`, '$.read_count')) AS INTEGER))
        - (SELECT count(*) FROM `reads` `r` WHERE `r`.`item_id` = `i`.`id` AND `r`.`status` = 'completed') AS `missing`,
      100 - (SELECT count(*) FROM `reads` `r` WHERE `r`.`item_id` = `i`.`id`) AS `room`
    FROM `items` `i`
    WHERE json_valid(`i`.`details`)
      AND trim(json_extract(`i`.`details`, '$.read_count')) <> ''
      AND trim(json_extract(`i`.`details`, '$.read_count')) NOT GLOB '*[^0-9]*'
  )
  SELECT `c`.`item_id`, 'completed' FROM `counted` `c` JOIN `n` ON `n`.`k` <= min(`c`.`missing`, `c`.`room`)
  ORDER BY `c`.`item_id`, `n`.`k`;
--> statement-breakpoint
UPDATE `reading_progress` SET `read_id` = (
  SELECT r.id FROM `reads` r WHERE r.item_id = `reading_progress`.`item_id`
  ORDER BY r.status = 'in_progress' DESC, CASE r.status WHEN 'completed' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, coalesce(r.ended_on, r.began_on) IS NULL, coalesce(r.ended_on, r.began_on) DESC, r.id DESC
  LIMIT 1
) WHERE `read_id` IS NULL;
--> statement-breakpoint
UPDATE items SET
  status = coalesce((SELECT r.status FROM reads r WHERE r.item_id = items.id ORDER BY CASE r.status WHEN 'completed' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, coalesce(r.ended_on, r.began_on) IS NULL, coalesce(r.ended_on, r.began_on) DESC, r.id DESC LIMIT 1), 'not_started'),
  began_on = (SELECT r.began_on FROM reads r WHERE r.item_id = items.id ORDER BY CASE r.status WHEN 'completed' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, coalesce(r.ended_on, r.began_on) IS NULL, coalesce(r.ended_on, r.began_on) DESC, r.id DESC LIMIT 1),
  completed_on = (SELECT r.ended_on FROM reads r WHERE r.item_id = items.id ORDER BY CASE r.status WHEN 'completed' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, coalesce(r.ended_on, r.began_on) IS NULL, coalesce(r.ended_on, r.began_on) DESC, r.id DESC LIMIT 1),
  read_count = (SELECT count(*) FROM reads r WHERE r.item_id = items.id AND r.status = 'completed'),
  rereading = EXISTS (SELECT 1 FROM reads r WHERE r.item_id = items.id AND r.status = 'in_progress')
    AND EXISTS (SELECT 1 FROM reads r WHERE r.item_id = items.id AND r.status = 'completed'),
  progress_page = (SELECT p.page FROM reading_progress p WHERE p.item_id = items.id
    AND p.read_id IS (SELECT r.id FROM reads r WHERE r.item_id = items.id ORDER BY r.status = 'in_progress' DESC, CASE r.status WHEN 'completed' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, coalesce(r.ended_on, r.began_on) IS NULL, coalesce(r.ended_on, r.began_on) DESC, r.id DESC LIMIT 1)
    ORDER BY p.at DESC, p.id DESC LIMIT 1)
WHERE id IN (SELECT item_id FROM reads);
--> statement-breakpoint
UPDATE `items` SET `details` = json_remove(`details`, '$.read_count')
WHERE json_valid(`details`)
  AND trim(json_extract(`details`, '$.read_count')) <> ''
  AND trim(json_extract(`details`, '$.read_count')) NOT GLOB '*[^0-9]*';
--> statement-breakpoint
DELETE FROM `import_in_progress`;
