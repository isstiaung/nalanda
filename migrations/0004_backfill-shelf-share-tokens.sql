-- Carry existing whole-shelf share links into the shares table so published
-- URLs keep working (same token, no filters = the whole shelf, sorted by title).
-- libraries.share_token stays in place but is no longer read or written.
-- (0003 is an intentionally empty no-op: it was applied locally before its
--  SQL landed, and applied migrations are never edited.)
INSERT INTO shares (token, name, library_id, sort)
SELECT share_token, name, id, 'title'
FROM libraries
WHERE share_token IS NOT NULL;
