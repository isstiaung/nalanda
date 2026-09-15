-- Custom migration (hand-written): tell a connection its borrowed book came back
-- (docs/proposals/connections.md §10). Drizzle's DSL can't express triggers.
--
-- Marking a loan returned uses the existing button and route, unchanged. For a loan made to a
-- connection — only those, found through connection_loans — this queues a `Returned` message in
-- the outbox for that connection, numbered in that connection's own sequence. It reaches them when
-- they next pull the outbox, or sooner, when a page load here retries undelivered pushes.
--
-- The activity id is generated in the INSERT and copied into the message by the UPDATE that follows,
-- so the message and its outbox row carry the same id. Without a library address nothing is queued.

CREATE TRIGGER `connection_loans_returned` AFTER UPDATE OF `returned_on` ON `loans`
WHEN old.returned_on IS NULL AND new.returned_on IS NOT NULL
  AND EXISTS (SELECT 1 FROM `connection_loans` WHERE `loan_id` = new.id)
  AND EXISTS (SELECT 1 FROM `federation_settings` WHERE `id` = 1)
BEGIN
  UPDATE `connections` SET `outbox_seq` = `outbox_seq` + 1
  WHERE `id` = (SELECT `connection_id` FROM `connection_loans` WHERE `loan_id` = new.id);
  INSERT INTO `outbox` (`connection_id`, `seq`, `activity_id`, `message`)
  SELECT cl.connection_id, c.outbox_seq,
    'urn:uuid:' || lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
      lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
    json_object(
      '@context', 'https://www.w3.org/ns/activitystreams',
      'type', 'Returned',
      'actor', (SELECT `base_url` FROM `federation_settings` WHERE `id` = 1),
      'request', cl.request_activity_id,
      'returnedOn', new.returned_on
    )
  FROM `connection_loans` cl JOIN `connections` c ON c.id = cl.connection_id
  WHERE cl.loan_id = new.id;
  UPDATE `outbox` SET `message` = json_set(`message`, '$.id', `activity_id`) WHERE `id` = last_insert_rowid();
END;
--> statement-breakpoint
-- Deleting a book that is lent to a connection ends that loan: they hear of it as a return, so their Borrowed
-- page doesn't show it out forever. Each notice is numbered in its connection's own sequence — ranked by loan,
-- in case two copies were lent to the same household — before the counter moves past them.
CREATE TRIGGER `connection_loans_item_deleted` BEFORE DELETE ON `items`
WHEN EXISTS (SELECT 1 FROM `loans` l JOIN `connection_loans` cl ON cl.loan_id = l.id
             WHERE l.item_id = old.id AND l.returned_on IS NULL)
  AND EXISTS (SELECT 1 FROM `federation_settings` WHERE `id` = 1)
BEGIN
  INSERT INTO `outbox` (`connection_id`, `seq`, `activity_id`, `message`)
  SELECT cl.connection_id,
    c.outbox_seq + (SELECT count(*) FROM `loans` l2 JOIN `connection_loans` cl2 ON cl2.loan_id = l2.id
                    WHERE l2.item_id = old.id AND l2.returned_on IS NULL
                      AND cl2.connection_id = cl.connection_id AND cl2.loan_id <= cl.loan_id),
    'urn:uuid:' || lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
    json_object(
      '@context', 'https://www.w3.org/ns/activitystreams',
      'type', 'Returned',
      'actor', (SELECT `base_url` FROM `federation_settings` WHERE `id` = 1),
      'request', cl.request_activity_id,
      'returnedOn', date('now')
    )
  FROM `loans` l JOIN `connection_loans` cl ON cl.loan_id = l.id JOIN `connections` c ON c.id = cl.connection_id
  WHERE l.item_id = old.id AND l.returned_on IS NULL;
  UPDATE `connections` SET `outbox_seq` = `outbox_seq` + (
    SELECT count(*) FROM `loans` l JOIN `connection_loans` cl ON cl.loan_id = l.id
    WHERE l.item_id = old.id AND l.returned_on IS NULL AND cl.connection_id = `connections`.`id`)
  WHERE `id` IN (SELECT cl.connection_id FROM `loans` l JOIN `connection_loans` cl ON cl.loan_id = l.id
                 WHERE l.item_id = old.id AND l.returned_on IS NULL);
  UPDATE `outbox` SET `message` = json_set(`message`, '$.id', `activity_id`) WHERE json_extract(`message`, '$.id') IS NULL;
END;
--> statement-breakpoint
-- Requests waiting for a book that is deleted are declined, so the household that asked isn't left waiting. A
-- connection has at most one request waiting per book.
CREATE TRIGGER `borrow_requests_item_deleted` BEFORE DELETE ON `items`
WHEN EXISTS (SELECT 1 FROM `borrow_requests` WHERE `our_item_id` = old.id AND `incoming` = 1 AND `status` = 'pending')
  AND EXISTS (SELECT 1 FROM `federation_settings` WHERE `id` = 1)
BEGIN
  INSERT INTO `outbox` (`connection_id`, `seq`, `activity_id`, `message`)
  SELECT br.connection_id, c.outbox_seq + 1,
    'urn:uuid:' || lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
    json_object(
      '@context', 'https://www.w3.org/ns/activitystreams',
      'type', 'BorrowDecline',
      'actor', (SELECT `base_url` FROM `federation_settings` WHERE `id` = 1),
      'request', br.activity_id
    )
  FROM `borrow_requests` br JOIN `connections` c ON c.id = br.connection_id
  WHERE br.our_item_id = old.id AND br.incoming = 1 AND br.status = 'pending';
  UPDATE `connections` SET `outbox_seq` = `outbox_seq` + 1
  WHERE `id` IN (SELECT `connection_id` FROM `borrow_requests`
                 WHERE `our_item_id` = old.id AND `incoming` = 1 AND `status` = 'pending');
  UPDATE `outbox` SET `message` = json_set(`message`, '$.id', `activity_id`) WHERE json_extract(`message`, '$.id') IS NULL;
END;
