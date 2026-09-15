# Proposal — Connections between Nalanda instances

> **Status: approved 2026-09-15; being built in phases (§15), one pull request per phase.**
> Recorded as ARCH.md §16 #29, which points here for the design. When a phase's build has to
> differ from this document, that phase's pull request updates it. **Phases 1 (keys and
> connections) and 2 (feed) are built.**

Two households each self-host Nalanda. If they choose to connect, they can see a feed of
each other's reading, comment on each other's reviews, ask to borrow a book, and lend to
each other with the loan tracked on both sides.

## 0. This reverses a recorded non-goal

ARCH.md §14 lists **"social features"** and **"background jobs of any kind"** as
non-goals. This proposal adds the first, deliberately. It is designed so it does **not**
need the second: no cron, no queue, nothing running unless a request is being served —
consistent with §4 ("no queues, no cron, no cache layer, no second service"). If approved,
§14 is updated rather than quietly contradicted.

## 1. Scope

**Goals** — between two instances that have explicitly connected:

- a feed of each other's activity (reviewed, rated, finished)
- comments on each other's reviews, both directions
- request to borrow a book the other household owns
- lend to a connected household, tracked on both sides

**Non-goals**

- ActivityPub or any fediverse interop — Mastodon, BookWyrm and other software cannot
  follow, read, or reply
- discovery: no directory, no search for strangers, no public profiles
- connecting with anyone you haven't exchanged an invite with
- real-time delivery
- end-to-end encryption — each household's admin can read what reaches their instance
- per-person identities inside a household (see §3)
- a network: being connected to two households never lets them see or reach each other
  (see §3)

## 2. Additive, by construction

- **Off unless the instance has a federation key** (`FEDERATION_PRIVATE_KEY` secret).
  Without it every new route returns 404, no new UI renders, and the new triggers write
  nothing. An instance that never opts in behaves exactly as it does today.
- New code lives in `src/federation/`. New tables arrive in **append-only
  migrations, one per phase**; no existing table is altered and no existing migration is
  edited.
- **No existing handler changes behaviour.** Existing files touched, each an insertion:

  | File | Insertion |
  |---|---|
  | `src/index.ts` | mount federation routes in the public section (signature auth), new pages after the session middleware; on an instance with a federation key, a cross-origin resource policy on `/covers/*` (§7) |
  | `src/env.ts` | optional `FEDERATION_PRIVATE_KEY` binding type |
  | `src/views/layout.tsx` | Feed / Connections / Borrowed nav links, only when enabled |
  | `src/routes/items.tsx` | a comments section under the review, only when enabled |
  | `src/routes/loans.tsx` | an incoming-requests section, only when enabled |
  | `scripts/backup.mjs` | append new tables — its `TABLES` list is fixed, so without this they would silently not be backed up |
  | `src/db/schema.ts` | new tables appended after the existing ones — drizzle-kit reads the schema from this one file. Their queries live in a new `src/db/federation.ts`, so `queries.ts` stays untouched while `src/db/` remains the only code touching D1 |
  | `package.json` | a `federation:keygen` script |
  | `public/app.css` | feed styles, appended |

- **The one database-level side effect on existing tables:** triggers on `items` and
  `loans` that append to new tables, and write nothing unless the household shares at least
  one connection view — the database can't see the federation key, so a view's existence is
  the switch. This
  is the same technique the FTS5 index already uses (`migrations/0001_fts.sql`), and it
  means event recording needs no handler changes.
- The existing test suite must pass **unmodified** — that is the check that "additive"
  held.
- `wrangler.jsonc` is unchanged: a runtime secret, no cron, no new bindings.

## 3. The unit that connects is a household

Reviews and ratings live on the item — `items.review` and `items.rating`, one per book per
household, not one per person — and loans belong to the household too. So an **instance**
connects to an **instance**.

- **Admin only:** create invites, confirm connections, disconnect, choose what connections
  see. Same line as share links today (§8: admins publish).
- **Any member:** read the feed, comment, request a book, accept or decline a request. Same
  line as loans today.
- Activity is attributed to the **household name** the admin chooses, not to usernames —
  share pages already never show usernames. Comments are the exception: they carry their
  author's display name, because the commenting household chose to send it. *(Decision 2, §16.)*

### Pairwise, never a network

Every connection is strictly between two households. If A is connected to B and to C, that
creates two separate relationships — it never lets B and C see or reach each other.

- **An instance serves only its own household's data.** Nothing received from one connection
  — their activity, their comments, details of a book borrowed from them — is ever served to
  another.
- **Connection lists are never exposed.** No "mutual connections", no friends of friends.
- **Comments stay between the two households involved** (decision 5): C can see A's review,
  but not B's comment on it.
- **Availability says a book is out, never to whom** (§10), so lending to C tells B nothing
  about C.

## 4. Identity and keys

- Each instance has **one signing keypair**. The private key is a runtime secret
  (`wrangler secret put FEDERATION_PRIVATE_KEY`), generated by a new
  `scripts/federation-keygen.mjs` — handled like `SESSION_SECRET`. The public key is
  published in the instance descriptor.
- **Algorithm: Ed25519** (`ed25519` in the RFC 9421 registry), chosen by the phase 1 spike.
  Measured inside workerd: 0.015 ms to sign, 0.045 ms to verify, 64-byte signatures, and keys
  that round-trip through JWK. ECDSA P-256 was close (0.020 / 0.050 ms); RSA-2048 was far
  slower to sign (0.62 ms). Hashing a 256 KB body — the largest the hard limits allow — takes
  0.15 ms. All of it is a small fraction of the 10 ms budget. The implementation is checked
  byte for byte against RFC 9421's own Ed25519 example (Appendix B.2.6).
- **Identity is the key, not the domain.** Connections store both, so a later phase can
  let an instance announce a domain change signed by the same key, without reconnecting.
- Losing the key means reconnecting everyone. It is not in D1, so it is **not in
  backups** — the runbook must say to keep a copy somewhere safe.

## 5. Connecting

A invites B:

1. A's admin creates an invite: a 256-bit random token, stored only as a SHA-256 hash,
   single-use, expiring after 7 days. The link is `<origin>/connect#<token>`. The token rides
   in the fragment, which browsers never send to a server, so opening the link by mistake
   puts it in nobody's logs — that page only explains what to do with it. A sends the link
   privately, out of band.
2. B's admin pastes it into B's Connections page.
3. B fetches `GET https://a/.well-known/nalanda` → household name, public key, protocol
   version.
4. B sends `POST https://a/federation/connect` with the token, B's base URL, B's public
   key and B's household name — signed with B's private key.
5. A checks, **local work first, database next, outbound fetch last:**
   1. the request signature verifies against the key in the body — B holds that key. This is
      pure CPU, so an unsigned or forged request is turned away without touching the database
   2. an unused, unexpired invitation exists for the token's hash — otherwise 404. A failed
      lookup costs two indexed reads and writes nothing. There is deliberately no per-IP
      throttle, unlike logins: tokens are 256 random bits, so guessing gets nowhere, and a
      peer's request comes from its Worker. Cloudflare gives every Worker subrequest to
      another zone the same `CF-Connecting-IP` (`2a06:98c0:3600::103`), so a per-IP limit
      would let one misbehaving peer lock every household out
   3. only now, fetch `https://b/.well-known/nalanda` and confirm it serves the same key —
      B controls that domain
   4. record the pending connection and use the invitation up in one transaction, only while
      the invitation is still unused and the connection limit has room. Two simultaneous
      redemptions can't both succeed, and a failure at any step leaves the invitation usable
6. The connection is recorded as **pending**. A's admin sees B's household name and domain,
   and confirms or declines. *(Decision 3, §16.)*
7. On confirmation A sends a signed acceptance to B, and both sides mark the connection
   active.

**Why the order in step 5 matters:** step 5.4 makes A's Worker fetch a URL the caller
chose. Doing it only after a valid invitation is found means a stranger cannot use A as a fetch proxy.

**Disconnecting:** either admin, at any time. A signed disconnect notice is sent best-effort;
the other instance marks the connection revoked and deletes everything it cached from it.
A well-behaved Nalanda complies. A modified one might not — see §11.

## 6. Every request after connecting is signed

- **HTTP Message Signatures (RFC 9421), one fixed profile, no negotiation.** Covered
  components: `@method`, `@target-uri`, and `content-digest` (RFC 9530) for requests with
  bodies; parameters `created` and `keyid`. A fixed profile is small enough to write on
  WebCrypto directly — **no new dependency**.
- Rejected unless the `keyid` names an active connection, the signature verifies, and
  `created` is within 5 minutes.
- **Replay:** every activity carries an `urn:uuid:` id. Control messages — accept, decline,
  disconnect — are recorded in `federation_seen` for an hour, well past the signature window,
  so a replay is a no-op; later phases add unique constraints on the ids their tables store. A
  replayed GET only re-reads data that connection is already allowed to read.
- **Spam can't spend the D1 allowance.** An unsigned or malformed request is turned away
  before the database is touched, and a signed request naming an unknown key costs one
  indexed read and no write. A message the connection's state doesn't allow — anything but
  withdrawing, from a household still waiting for confirmation — is refused before any write,
  and every message a connection gets accepted counts toward its daily limit (§12).
- **The key cache never decides a state change.** A peer's key is cached per isolate for a
  minute once its signature verifies (like the share-page cache, §16 #19). Reads may use that
  row; anything that changes state re-reads the connection and acts only if it still carries
  the key that signed, and connection ids are never reused. One consequence: if a household
  disconnects and reconnects from the same address with a new key, isolates that didn't handle
  the disconnect reject its messages for up to that minute.
- `http://` is accepted only for `localhost`, so two local instances can connect in
  development — each with its own `--persist-to` state and its own key through `--env-file`
  (runbooks/connections.md). Note that `--env-file` replaces `.dev.vars` rather than adding
  to it.

## 7. What connections can see

**Nothing by default.** The admin chooses **connection views**: the same captured-filter
model as share views (shelf, type, status, holding), stored in a new `connection_views`
table so `shares` is untouched. A connection view is visible to all connections. *(Decision 4, §16.)*

Fields go through a new whitelist, `toConnectionItem()`, modelled on `toPublicItem()`:

- **Same as share pages:** title, creators, cover, publisher, published, description, media
  details, tags, rating, review, `inCollection`.
- **Added for connections:** `completedOn` (so the feed can say "finished"),
  `updatedAt` (ordering), and `available` (§10) — derived, like `inCollection`, so no
  borrower, due date or copies count leaves the instance.
- **Never, same as share pages:** private notes, loans and borrowers, the copies count,
  `added_by`, usernames.
- **Covers:** pages at B hotlink `https://a/covers/<uuid>` — already public by design
  (§9). B drops any cover URL that is not exactly that pattern on the connection's own origin, so a peer cannot make your pages load arbitrary third-party images. Feed entries carry only the
  cover key, and B builds the URL. Browsers would block those images under the app's
  `Cross-Origin-Resource-Policy: same-origin` header, so an instance with a federation key
  serves `/covers/*` with `cross-origin` instead.

Connection views and share links are **separate on purpose.** A share link is for anyone
holding the URL; a connection view is for households you've connected with. Publishing one
never publishes the other.

**Shelves are read live, never stored.** When a member of B browses A's shared shelf, B
fetches the page from A (`GET /federation/shelf?view=<id>&page=<n>`, up to 60 items with
availability) and keeps it in the Worker's memory for five minutes, keyed by connection,
view and page. Nothing is written to B's database, so it never reaches B's Time Travel
history or backups. A's edits and removals show up within five minutes. After a disconnect
A refuses B's requests, and anything still in B's memory expires within those five minutes.

The trade-off is that browsing needs A online. That costs nothing in practice: requesting a
book (§10) needs A online anyway.

## 8. Feed

Nalanda has no event history today — items only have current state and `updated_at`.

- **Recording:** a new `activity_log` table filled by triggers (migration 0007) — after an
  item's `review`, `rating`, `status` or `completed_on` changes, and on insert with those set.
  Each row records the item, a kind (reviewed, rated, finished) and a timestamp; the activity
  JSON is built at read time, not in SQL. There is **one row per item and kind**: a repeat — an
  edited review, a new rating, a re-read — replaces the row under a new id. The log never holds
  more than three rows per item, the id doubles as the feed cursor, and a connection holding
  the old id learns from the removal check that its copy is out of date. A review is compared
  with carriage returns dropped and surrounding whitespace trimmed, because a browser submits
  an untouched review with CRLF line endings and that isn't an edit.
- **The switch is a connection view.** The triggers write only while at least one connection
  view exists. Sharing a first view records the last 90 days of activity (the newest 300
  entries), so connections have something to follow straight away. Removing the last view
  clears the log, because an edit made while nothing is shared never replaces its row; the
  next first view starts afresh. View ids are never reused, so a withdrawn view's id can't
  come to mean a different view to the households that followed it.
- **Not logged in v1: "added to catalog."** A 2,000-book Goodreads import would bury every
  connection's feed. Bulk changes can still happen (an import that sets reviews), so the Feed
  page groups a household's events within a short window ("reviewed 40 books").

### Subscriptions — the receiving household decides

A feed is never pushed at anyone. The receiving household's admin **subscribes** to the
shared views they want from each connection, and chooses:

- **Which views**, from the list the sharing instance serves (`GET /federation/views`). Each
  view shows its item count and how busy it has been: activities and approximate size per
  month, from the last 90 days of `activity_log`.
- **How often** — a minimum interval between pulls: every 15 minutes, hourly or daily.
  Pulls still happen only when a member opens Feed or Loans; the interval limits how often
  that triggers one. No background job.
- **How long to keep entries** — a number of days (default 90) and a maximum number of
  entries (default 500) per subscription, whichever is reached first, plus a purge-now
  button.

**Estimates:** before subscribing, expected storage is shown as the monthly size multiplied
by the retention period, capped by the entry limit. Afterwards, the Connections page shows
what each connection actually uses: stored entries and bytes. Both live on a Feed page per
connection, linked from Connections. Retention counts from when the activity happened on the
owner's side.

Unsubscribing deletes that subscription's stored entries. Disconnecting deletes everything
stored from that connection.

### Pulling

`GET /federation/feed?view=<id>&since=<cursor>` returns activity on items inside that view: at
most 100 entries within 64 KB, with titles cut at 1,000 characters and reviews at 8,000.

- **After a cursor, the oldest entries come first.** `latest` is the last one sent and `more`
  says others are waiting, so a busy stretch arrives over several pulls instead of being cut;
  a subscription with more waiting is due again on the next page load.
- **A new subscriber, with no cursor, gets the newest page instead**, so a feed starts from the
  present rather than replaying the past.
- **The cursor only ever names activity inside the view**, so it can't reveal what happens
  outside it.
- **Each entry carries only what its kind shows**: the review only on a reviewed entry, the
  rating only on a rated one. Withdrawing a review leaves no copy behind in the entries that
  remain, and the receiver blanks those fields again before storing.
- **Entry dates from the future are stored as now**, so they can neither top the Feed page nor
  outlive retention.

Feed responses are plain JSON rather than ActivityStreams collections, since nothing outside
Nalanda reads them. When a member opens Feed, stored entries render immediately — a page at a
time, within 128 KB — and up to two subscriptions past their interval refresh in `waitUntil`;
phase 3 adds the same on Loans, together with the outbox.

**Messages addressed to you travel separately from the feed.** Comments, borrow requests,
responses and return notices meant for a household are listed at
`GET /federation/outbox?since=<cursor>`, which is pulled from **every** active connection
when a member opens Feed or Loans — whether or not you subscribe to any of their views. It is
the delivery fallback for pushes that failed (§9, §10), so a friend's comment or request
can't be lost just because you don't follow their feed. It stays small: it holds only what
that connection addressed to you, within the daily push limit.

A page refreshes at most a fixed number of subscriptions and outboxes per request and
staggers the rest, staying inside the free plan's per-request subrequest limit.

### Removals — checked on every pull

A stored entry has to go once its owner stops sharing it: the review is deleted, the book is
deleted, the book no longer matches the view (it moved shelf or changed status), or the
whole view is removed.

With each pull, the receiving instance also sends the ids of the entries it holds for that
subscription to `POST /federation/feed/check`. The owner replies with the ones that are no
longer valid, and the receiver deletes them. An entry is valid only while its item exists,
still matches the view, and still carries what the entry shows — a review entry needs its
review. The Feed page notes how many entries their owners removed since the last visit,
without saying what they were.

- **Why a check instead of a list of deletion markers (tombstones):** the owner doesn't
  record what it sent to whom. A marker list can't cover a book drifting out of a view, or a
  whole view deleted, without enumerating every affected item. The check covers every case,
  keeps nothing extra on the owner's side, and has no expiry window to miss — a household
  that hasn't pulled for months simply runs the check on its next pull.
- **Lifecycle rules run before every pull**, so what has expired goes even when the owner
  can't be reached, and the Feed page hides entries past their retention either way.
- **Honouring removals always applies.** It is not one of the receiver's lifecycle options:
  lifecycle rules decide how long the receiver keeps what is still shared, and cannot keep
  what the owner removed.
- The check is small, because it is bounded by the entry limits. It cannot prove deletion
  on a modified instance (§11); it keeps well-behaved ones in step.

## 9. Comments on reviews

The reviewer's household is authoritative for the thread.

1. A member of B comments on A's review, seen in B's feed.
2. B keeps its own copy (so B can show "you commented") and sends a signed `Create` with a
   `Note` whose `inReplyTo` is A's item, to `POST https://a/federation/inbox`.
3. A stores it in `remote_comments`; A's item page shows it beneath the review.
4. A's members reply the same way, sent to B.

- **Plain text only**, escaped on render (hono/jsx escapes by default). No remote HTML, no
  markdown, no auto-embedded images.
- Visible only to the **reviewer's household and the commenter's household** — not to A's
  other connections, who never connected with B. *(Decision 5, §16.)*
- A can delete any comment on its own reviews; B can withdraw its own (signed `Delete`).
  Disconnecting removes all of them.
- **Delivery without a retry queue:** the push is best-effort in `waitUntil`. If A is down,
  the comment is also listed in B's outbox for A (§8), so A collects it the next time
  one of A's members opens Feed or Loans. Pull is the guarantee; push just makes it fast.

## 10. Requests and lending

1. B browses A's shared shelves live (§7). Only items with `inCollection` and `available`
   both true can be requested.
2. A member of B requests one, with an optional note: a signed `BorrowRequest` to A's inbox,
   recorded on both sides in `borrow_requests`.
3. Any member of A accepts or declines. **Accepting creates an ordinary loan** in the
   existing `loans` table — borrower "Narain (Narain's Library)", due date as usual — plus a
   row in a new `connection_loans` table linking that loan to the connection and request.
   The existing Loans page, overdue logic and return button keep working unchanged.
4. B records it in a new `borrowed_items` table and shows it on a new Borrowed page. It
   never enters B's catalog.
5. When A marks the loan returned with the existing button, a trigger on
   `loans.returned_on` — only for loans linked in `connection_loans` — records that the loan
   was returned. The notice is built, signed and sent in `waitUntil` on A's next
   authenticated page load, and also listed in A's outbox for B to pull (§8).

- Connections **can see whether a book is available**: a derived boolean, `available`,
  true while at least one copy is not out on loan (`copies` greater than the number of
  active loans). A book held in three copies with one lent still reads available. The
  Request button is disabled while nothing is available. *(Decision 6, §16.)*
- **Who** has it, when it's **due**, and loan **history** are never shown — the same line
  §9 draws for share pages. The one inference this allows is intended: a connection can
  see a book become unavailable.
- Lending activities are Nalanda-specific types (`BorrowRequest`, `BorrowAccept`,
  `BorrowDecline`, `Returned`) in an ActivityStreams envelope. No interop is needed, so they
  are named for what they mean.

## 11. Threat model

| Who | What they can do | Mitigation, or why it's acceptable |
|---|---|---|
| A stranger | fetch `/.well-known/nalanda` (household name, public key); POST `/federation/connect` | connecting needs an unguessable single-use token; a failed attempt writes nothing, and nothing is fetched before the token check |
| Someone holding a leaked invite | redeem it once, within 7 days | it lands as pending; the admin sees the domain and declines; unused invites are revocable |
| A connected household | read your connection views and whether those books are available; comment; request | that is the feature; delete comments, decline requests, disconnect |
| A disconnected household | keep copies of feed entries they had stored | shelves were never stored (§7); a well-behaved Nalanda deletes stored entries; a modified one can't be forced to — **only connect with people you'd trust with a copy** |
| A connected household sending too much | push oversized comments or floods of requests; answer pulls with huge responses | hard limits (§12): length limits, a daily push limit per connection, and receivers stop reading oversized responses |
| A network attacker | nothing useful | TLS, plus signatures over method, URL and body digest |
| A replayed request | nothing | 5-minute `created` window; unique activity ids |
| Hostile content from a peer | nothing executes | plain text, escaped; cover URLs restricted to the peer's own `/covers/<uuid>` |
| Someone with your federation private key | impersonate you to your connections | v1: new key and reconnect; signed key rotation in a later phase |

## 12. Free-tier fit (ARCH.md §12)

- **No new Cloudflare products:** no Queues, KV, Durable Objects or Cron Triggers.
- **No new runtime dependency:** WebCrypto plus a fixed RFC 9421 profile.
- **CPU:** one signature verification per inbound request, one signing per outbound. To be
  measured on workerd in the phase 1 spike against the 10 ms budget.
- **D1 writes:** only from authenticated connections, admin actions, and triggers that are
  inert while disabled.
- **Requests:** descriptor lookups, feed pulls and live shelf pages between a handful of
  friends — noise against 100,000/day.
- **Storage:** shelves are never stored; stored feed entries are bounded by each
  subscription's lifecycle rules and a hard ceiling per connection.

### Hard limits

Subscriptions and lifecycle rules govern what a household *pulls*. They can't stop a
misbehaving instance from ignoring the page size it was asked for, and they don't cover what
gets *pushed* into an inbox. These limits apply regardless of anyone's settings. Starting
values, to be tuned during phases 1 and 2:

| Limit | Starting value | Protects |
|---|---|---|
| Feed entries per response | 100, within 64 KB; titles cut at 1,000 characters, reviews at 8,000 | the receiver's CPU and storage |
| Feed response read | 128 KB | the receiver's CPU |
| New feed entries stored per connection per day | 500, then dropped | the receiver's daily D1 write allowance |
| Feed reads per connection | 60 per 10 minutes, per isolate; the view list cached for 5 minutes | the owner's daily D1 read allowance |
| Stored entries per Feed page | 200, within 128 KB | the receiver's CPU |
| Ids in one removal check | 1,000 | the owner's CPU |
| Connection views | 20 | the size of `/federation/views` |
| Subscriptions refreshed per page load | 2, two subrequests each | the per-request CPU and subrequest limits |
| Shelf items per page | 60, as on today's shelf pages | the receiver's CPU |
| Response body read | 256 KB — past that, the pull is abandoned | the receiver's CPU and storage |
| Comment length | 2,000 characters | the owner's database |
| Borrow-request note | 500 characters | the owner's database |
| Pushes accepted per connection per day | 200, then refused | the owner's daily D1 write allowance |
| Stored feed entries per connection | 1,000, whatever the lifecycle settings | the receiver's database |
| Active connections | 25 | a Feed refresh stays within one request's subrequest budget |

## 13. Data model — new tables, added phase by phase

| Table | Purpose |
|---|---|
| `federation_settings` | singleton: household name and address |
| `connections` | peer base URL, public key, household name, status (pending, active, revoked), outbox cursor |
| `feed_subscriptions` | which of a connection's views we follow: pull interval, retention days, entry limit, cursor, last pulled |
| `connection_invites` | token hash, created by, expires at, used at |
| `connection_views` | captured filters, same shape as `shares`, visible to connections |
| `activity_log` | trigger-fed: item, kind, timestamp — one row per item and kind |
| `remote_activities` | stored feed entries per subscription, under its lifecycle rules; unique on activity id |
| `remote_comments` | comments on our reviews, unique on activity id |
| `outgoing_activities` | comments, requests and return notices we sent, with delivery status |
| `borrow_requests` | both directions, with status |
| `connection_loans` | links an existing `loans` row to a connection and request |
| `borrowed_items` | books borrowed from connections |
| `federation_seen` | control-message ids processed in the last hour, so replays are no-ops |
| `connection_push_counts` | pushes accepted per connection per day, for the daily limit |

Tables arrive with the phase that uses them. Phase 1 created `federation_settings`,
`connection_invites`, `connections` (the outbox cursor arrives with phase 3), `federation_seen`
and `connection_push_counts`; a per-IP throttle table, `federation_attempts`, was planned and
dropped (§5, step 2). Phase 2 created `connection_views`, `activity_log`, `feed_subscriptions`
and `remote_activities`. The enabled flag planned for `federation_settings` was dropped too: a
connection view's existence is the triggers' switch (§8).

Durable tables are appended to `scripts/backup.mjs`. `federation_seen` and
`connection_push_counts` are replay and rate bookkeeping, worthless within a day, and are left
out on purpose. Folding tables together
(for example one activities table with a direction column) remains a reasonable call as
later phases land.

**Data portability:** this is not catalog data, so the existing `/export.csv` stays exactly
as it is. A separate `/federation/export.json` covers connections, comments sent and
received, and borrow history.

### Where each piece of data lives

ActivityStreams 2.0 is only the **shape of the JSON** two instances send each other — not a
service, a server or a place. There is no relay and no central store: messages go directly
from one household's Worker to the other's over HTTPS. Everything at rest sits in each
household's own D1 database (and R2 for covers), on each household's own Cloudflare account.

With A as the household that owns the data and B as a connection:

| Data | On A | On B |
|---|---|---|
| Catalog, private notes, copies, loans | existing tables — the source of truth | never |
| Books on shared shelves (whitelisted fields) | existing tables; the JSON is built when requested, not stored | never stored — held up to five minutes in the Worker's memory while browsing (§7) |
| Covers | R2 | not copied — B's pages load them from A's `/covers/<uuid>` |
| Feed activity | `activity_log`: item, kind, timestamp only | stored entries in `remote_activities`, under B's lifecycle rules, removed once A stops sharing them (§8) |
| B's comment on A's review | `remote_comments` — authoritative | B's own copy in `outgoing_activities` |
| A borrow request | `borrow_requests` | `borrow_requests` |
| A's loan to B | an ordinary `loans` row plus a `connection_loans` link | `borrowed_items` |
| A's private key | Cloudflare secret — not in D1, not in backups | never |
| A's public key and address | served at `/.well-known/nalanda` | `connections` |

The consequence worth stating plainly: **shelves never reach B's database, but stored feed
entries are copies under B's control.** On a well-behaved Nalanda, B's lifecycle rules bound
how many there are, the removal check (§8) prunes what A stops sharing, and disconnecting
deletes the rest. Nothing can force a modified one to (§11). And because covers load from A,
B's browser contacts A's instance directly whenever it shows A's books.

## 14. HTTP surface — all new

```
public — no session; every route 404s while disabled
GET  /.well-known/nalanda           household name, public key, protocol version
POST /federation/connect            redeem an invite (token-gated)

signed by an active connection
GET  /federation/views              shared views, each with item count and monthly feed volume
GET  /federation/feed?view=&since=  activities on items in that view
POST /federation/feed/check         which of the caller's stored entry ids are no longer shared
GET  /federation/outbox?since=      comments, requests, responses and return notices addressed to the caller
GET  /federation/shelf?view=&page=  one page of a shared shelf, with availability — never stored
POST /federation/inbox              comments, deletes, borrow requests and responses, returns, disconnect

session — rendered only when enabled
GET  /connections                   admin: invites, pending, active, connection views, storage used,
                                    disconnect
GET  /connections/:id/feed          admin: that household's shared views, what you follow, lifecycle
                                    rules, storage, purge
GET  /feed                          members: connections' activity
GET  /borrowed                      members: books borrowed from connections
GET  /federation/export.json        members: federation data export
     plus a comments section on /items/:id and a requests section on /loans
```

## 15. Phases

Each phase ends usable. **A phase is done only when two real local instances — each with its
own state directory and key, never the everyday dev database — have been connected and the
feature clicked through in a browser**, not when the suite passes.

1. **Keys and connections.** Spike first: RFC 9421 profile CPU cost on workerd, ECDSA P-256
   versus Ed25519. Then keygen script, descriptor, invites, handshake with admin
   confirmation, disconnect, signature module with tests.
2. **Feed.** Connection views, `activity_log` triggers, subscriptions with size estimates and
   lifecycle rules, the removal check, hard limits, Feed page.
3. **Comments.** Both directions, deletes, and the outbox as the pull fallback.
4. **Borrowing.** Live shelf browsing with the in-memory cache, requests, accept creates an
   ordinary loan, Borrowed page, return notices.

## 16. Decisions

Resolved with the owner on 2026-09-15.

1. **Households connect**, not individual people.
2. **Activity shows the household name; comments show their author's name.**
3. **Invites land as pending** until an admin confirms the connection.
4. **Connection views are visible to all connections** in v1.
5. **Comments are visible to the reviewer's and commenter's households only.** If A is
   connected to both B and C, and B comments on A's review, C still sees A's review but not
   B's comment — B never connected with C.
6. **Connections can see whether a book is available** (§10). Borrower, due date and loan
   history stay private.
7. **Any member can accept or decline a borrow request.**
8. **ARCH.md §14's "social features" non-goal is reversed on approval;** "background jobs of
   any kind" stays a non-goal.
9. **Connections are pairwise, never a network** (§3). Being connected to two households
   never lets them see or reach each other, and no instance re-serves what it received from
   one connection to another.
10. **The receiving household controls its subscriptions** (§8): which shared views, a
    minimum interval between pulls, and how long entries are kept — with estimated size
    before subscribing and actual usage after.
11. **Hard limits back those controls up** (§12), because controls only govern what a
    household pulls, not what it is sent.
12. **Shelves are read live with a five-minute in-memory cache; the feed is stored** (§7, §8).
13. **Removals reach a connection through a check on every pull, and always apply** (§8).
    Honouring an owner's removal is not one of the receiver's lifecycle options.

**Deferred — access control.** Who may confirm a connection (3) and choosing connection
views per connection (4) are left to a later role-based access design. ARCH.md §8 has two
roles and no permission matrix today, so that is its own decision rather than part of this
one.
