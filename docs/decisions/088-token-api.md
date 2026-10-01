# §16 #88 — A read-only API behind per-member tokens: made on the Account page, shown once, bound to the account as a session is; a token sees what its member sees and changes nothing

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #88`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A blog that lists what its author is reading, a script that counts the shelves, a phone widget:
each wants the library as data without a browser session. **The owner decided** on a read-only
token API, per member, with tokens made on the Account page.

**What was decided:**
- **Tokens, per member, on the Account page.** "Make a token" gives a name and shows the secret
  (`nal_` + 32 random bytes, base64url) **once, on that page, never in a URL** — the response is
  the page with the secret on it, not a redirect — and keeps only its SHA-256 (`api_tokens`,
  migration 0051). At most ten a member; each can be revoked there. A leaked table is no
  token.
- **Bound to the account as a session is** (#56, #70): a token row carries the account's id, its
  session key and the generation it was made in, and signs in only while the user row still has
  that key and that generation (`apiTokenUser()`, one join). So a removed member's token signs in
  nobody — a newcomer given the id has another key — and **"Sign out other devices", a new
  password or a reset take every token down**; sign-out-others deletes the rows in its batch, so
  the list stays honest, and a token from before a password change shows "no longer signs in".
- **`GET /api/v1/…`, JSON, `Authorization: Bearer <token>`**, mounted before the session
  middleware: a cookie signs nobody in here, and a token signs nobody into the pages. GET only
  (405 otherwise), `cache-control: no-store`, a member who must still change their password is
  refused. The routes are the app's own reads through the app's own queries:
  `/me`, `/libraries`, `/items` (the shelf's filters as its URL carries them, `parseShelfQuery()` —
  "Read by" and the decluttering filters included — on one shelf or all, **paged by id, 250 a
  request** with `after` and `next` as the export pages, #38, tags along), `/items/:id` (the item
  with its tags, every read with its reader, the reviews, the pages recorded, the loans out, and
  the members to name them), `/search` (the operators, #80), `/loans`, `/wants` (the token's
  member's), `/goals` (theirs, a year). **A token sees what its member sees**: notes, location,
  copies, prices — everything a member's page shows — and nothing a member can't; it is not a
  share whitelist, and it is never a share.
- **No writes**, by construction: there is no route that writes, and the method check refuses
  before any handler runs. Writing through the API is a later decision, not a missing feature.
- **Costs nothing extra on the pages**: the Account page reads the member's row and their tokens
  in one batch (`userWithTokens()`), so it stays at the calls it made; an API request is one
  lookup and then what the page it mirrors would read.

**What it rules out:** a cookie on the API or a token on the pages; tokens for other members
(a member makes their own; an admin's token is an admin's view, no more); scoped or expiring
tokens (revoke and remake); rate limiting beyond the free tier's own; OAuth; writes.

`test/api-tokens.spec.ts` holds it: the secret once on the page and only its hash kept, the
list and the revoke (one's own only), the cap; the token dying with other devices (rows gone), a
new password, the member's removal and a reused id; what is refused — no token, a malformed or
unknown one, a cookie, a write, an unknown route, a member who must change their password, and a
token on a page; items with the shelf's filters and tags, paged by id past 250, one item with its
reads, reviews, loans and people; libraries, search, the want list, loans, a goal; and the Account
page's call count unchanged.
