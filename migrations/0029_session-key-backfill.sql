-- Custom migration (hand-written): a session key for every account that exists (ARCH.md §16 #56).
-- Drizzle's DSL can't express the data. 0028 added users.session_key with a placeholder '' — SQLite allows no random
-- default on a column added to a table that has rows — and this gives each existing account its own.
--
-- 16 random bytes each, as 32 hex digits: SQLite has no base64, and hex digits are base64url characters, so these read
-- like the keys the app makes (22 characters of base64url, also 16 bytes). randomblob() is evaluated once per row.
-- What the key must be is new for each account, never the same as one before it at the same id; it guards nothing on
-- its own — a cookie is only believed once its HMAC checks out, and only SESSION_SECRET makes one.
--
-- Every session cookie signed before this has no key in it, and from this release on such a cookie signs nobody in:
-- everyone logs in again, once. No trigger watches users, so nothing here reaches connections.

UPDATE `users` SET `session_key` = lower(hex(randomblob(16))) WHERE `session_key` = '';
