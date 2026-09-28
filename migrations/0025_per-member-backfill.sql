-- Custom migration (hand-written): everyone's reading and reviews so far, credited to a person (ARCH.md §16 #43).
-- Drizzle's DSL can't express the data. 0024 made reads.reader_id and the reviews table; this fills them.
--
-- Nothing before this said who read a book or who rated it, so all of it goes to the first admin — the admin with the
-- lowest id, on most instances the person who ran /setup. An admin moves anything misattributed from the book's page
-- ("Move to"). On an instance with no admin (only possible in a hand-built database) it all stays unattributed.
--
--   reads             every read, to the first admin
--   reading_progress  every page, to the first admin too: a page belongs to its read's reader, so the pages of a read
--                     and the read agree (pages recorded by another member included — they go with their read)
--   reviews           one row per item with a rating or a review, the first admin's, holding exactly what the item
--                     holds. Its time is the item's updated_at: the last the review could have been written.
--
-- The items themselves aren't touched. Their rating and review are now the summary of their reviews, and with one
-- review each that summary is the review itself; their status and dates are the summary of everyone's reads, which
-- with one reader is what they already say. No trigger fires, so none of this reaches connections.

UPDATE `reads` SET `reader_id` = (SELECT min(`id`) FROM `users` WHERE `role` = 'admin')
WHERE `reader_id` IS NULL;
--> statement-breakpoint
UPDATE `reading_progress` SET `added_by` = (SELECT min(`id`) FROM `users` WHERE `role` = 'admin')
WHERE EXISTS (SELECT 1 FROM `users` WHERE `role` = 'admin');
--> statement-breakpoint
INSERT INTO `reviews` (`item_id`, `user_id`, `rating`, `review`, `created_at`, `updated_at`, `reviewed_at`)
  SELECT `id`, (SELECT min(`id`) FROM `users` WHERE `role` = 'admin'), `rating`, `review`, `updated_at`, `updated_at`,
    CASE WHEN `review` IS NOT NULL THEN `updated_at` END
  FROM `items` WHERE `rating` IS NOT NULL OR `review` IS NOT NULL ORDER BY `id`;
