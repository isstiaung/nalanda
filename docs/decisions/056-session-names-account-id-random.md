# §16 #56 — A session names an account by its id and a random key, because ids are reused

**Decided:** 2026-09-30 (session identity). Cited as `ARCH.md §16 #56`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

`users.id`
is `INTEGER PRIMARY KEY` without `AUTOINCREMENT` (migration 0000), so SQLite gives a new row
max(id)+1: removing the newest member frees their id for the next account made. The session
cookie was `{u, e}` — an id, signed — and the middleware only asked whether a row with that id
existed, so a removed member's cookie, good for up to 30 days, signed its holder in as whoever
was created next (a reviewer reproduced it: remove b, create c, b's cookie opens `/account` as
c). Fixed by giving every account an identity that is never reused:
- **`users.session_key`**: 16 random bytes, base64url, set in the statement that makes the
  account — `createUser()`, and `createFirstAdmin()`'s guarded batch, whose `RETURNING` hands
  the key to setup's sign-in. Migration 0028 adds the column (`NOT NULL DEFAULT ''`: SQLite
  allows no random default on a column added to a table with rows) and 0029 fills each
  existing row with `lower(hex(randomblob(16)))`, 32 hex digits — SQLite has no base64, and
  hex digits are base64url characters. A key's job is only never to repeat at an id, not to be
  secret: nothing is believed before its HMAC checks out, and only `SESSION_SECRET` makes one.
  So `randomblob()`'s PRNG is ample, and the comparison is a plain `===` — the cookie's holder
  can read the key inside it already, and knowing another account's key forges nothing.
- **The cookie is `{u, k, e}`.** `verifySessionToken()` refuses a token without a well-formed
  `k`; the middleware compares `k` with the row it already reads (`sessionMatches()`), so the
  check adds **no D1 call** — tests hold five pages to the counts main made before.
- **Old cookies are refused, not grandfathered.** Accepting `{u, e}` until it expired would have
  kept the hole open for 30 days after the fix shipped, for exactly the cookies it exists to
  stop. Refusing them signs everyone out once, on upgrade — a login each, in a household
  app — and the release's Upgrading note says so.
- **An empty key never signs anyone in**, and createSessionToken() refuses to sign one. A row
  without a usable key — inserted by hand, or restored from a backup taken before 0029 — gets
  a fresh key at its next password login (`ensureSessionKey()`), so it degrades to "log in
  again", never to a shared key.
- **The key never changes.** It is who the account is, not a credential: a password change or
  an admin's reset leaves it, and every session, as it was — as before this change.
- **Anything else that remembers a person across time binds the key too.** A per-user value
  that outlives a request — an HMAC stamp such as the offline scan queue's — is taken over
  `accountIdentity(user)` (`"<id>:<key>"`; the session's user carries the key), never the id,
  or the same reuse reopens there. Rows that point at users by id don't carry over: deleteUser()'s
  batch clears `items.added_by`, `reading_progress.added_by`, `reads.reader_id` and
  `reviews.user_id`; `ON DELETE SET NULL` clears `connection_invites.created_by`,
  `comments.author_id` and `borrow_requests.requester_id`; the per-person seen markers
  (`notifications_seen_id`, `feed_seen_id`) live on the row itself. Share tokens and
  notifications belong to the household, not to anyone's id.

**Not done, for the owner to decide: signing out other sessions on a new password.** Replacing
the key on a password change would sign out that account's other devices, and on an admin's
reset would sign the member out everywhere — a way to revoke one person's sessions short of
rotating `SESSION_SECRET` for the household, and a reset is the natural place for it. It was
built and then left out, because it would change the key that identity-bound stamps hang
from: the offline scan queue's stamp would change under a device that changed its own
password, and that device would silently drop its queued scans. Done properly it wants a
second, rotating value beside the identity key (a `session_generation` counter the cookie
also names, say), in its own migration.

**Chosen without asking, overrulable:** refusing old cookies over grandfathering them;
keeping `AUTOINCREMENT` off `users` — adding it means rebuilding a table half the schema
references, and the key makes id reuse harmless for sessions anyway; no unique index on the
key, since a session is matched by id *and* key, and a collision at 128 bits is not a risk
worth a migration ordering problem (0028 would have to index a column full of `''`); an
account without a key gets one at its next password login rather than being locked out.
