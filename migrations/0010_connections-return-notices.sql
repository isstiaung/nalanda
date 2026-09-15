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
