# Proposal — Connections between Nalanda instances

> **Status: proposed, not implemented.** Open questions resolved with the owner on
> 2026-09-15 (§16); still awaiting approval to build. On approval it folds into ARCH.md as a
> new section plus a §16 decision-log entry; until then ARCH.md remains the source of truth
> and this document changes nothing.

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
- New code lives in `src/federation/`. New tables arrive in **one new append-only
  migration**; no existing table is altered and no existing migration is edited.
- **No existing handler changes behaviour.** Existing files touched, each an insertion:

  | File | Insertion |
  |---|---|
  | `src/index.ts` | mount federation routes in the public section (signature auth), new pages after the session middleware |
  | `src/env.ts` | optional `FEDERATION_PRIVATE_KEY` binding type |
  | `src/views/layout.tsx` | Feed / Connections / Borrowed nav links, only when enabled |
  | `src/routes/items.tsx` | a comments section under the review, only when enabled |
  | `src/routes/loans.tsx` | an incoming-requests section, only when enabled |
  | `scripts/backup.mjs` | append new tables — its `TABLES` list is fixed, so without this they would silently not be backed up |

- **The one database-level side effect on existing tables:** triggers on `items` and
  `loans` that append to new tables, and write nothing while federation is disabled. This
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
- **Algorithm: ECDSA P-256** via WebCrypto (`ecdsa-p256-sha256` in the RFC 9421
  registry). Ed25519 is smaller and faster but its workerd support is unconfirmed — the
  phase 1 spike decides.
- **Identity is the key, not the domain.** Connections store both, so a later phase can
  let an instance announce a domain change signed by the same key, without reconnecting.
- Losing the key means reconnecting everyone. It is not in D1, so it is **not in
  backups** — the runbook must say to keep a copy somewhere safe.

## 5. Connecting

A invites B:

1. A's admin creates an invite: a 128-bit random token, stored only as a SHA-256 hash,
   single-use, expiring after 7 days. A sends the link privately, out of band.
2. B's admin pastes it into B's Connections page.
3. B fetches `GET https://a/.well-known/nalanda` → household name, public key, protocol
   version.
4. B sends `POST https://a/federation/connect` with the token, B's base URL, B's public
   key and B's household name — signed with B's private key.
5. A checks, **cheapest and local first, outbound fetch last:**
   1. per-IP throttle
   2. the token hash exists, is unexpired, and is consumed by a single conditional update
      (`… WHERE used_at IS NULL`) — otherwise 404
   3. the request signature verifies against the key in the body — B holds that key
   4. only now, fetch `https://b/.well-known/nalanda` and confirm it serves the same key —
      B controls that domain
6. The connection is recorded as **pending**. A's admin sees B's household name and domain,
   and confirms or declines. *(Decision 3, §16.)*
7. On confirmation A sends a signed acceptance to B, and both sides mark the connection
   active.

**Why the order in step 5 matters:** step 5.4 makes A's Worker fetch a URL the caller
chose. Doing it only after the token is consumed means a stranger cannot use A as a fetch
proxy.

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
- **Replay:** every activity carries a UUID `id`, and every table that receives activities
  has a unique constraint on it, so a replayed POST is a no-op. A replayed GET only re-reads
  data that connection is already allowed to read.
- **Spam can't spend the D1 allowance:** active connection keys are cached per isolate (like
  the share-page cache, §16 #19), so an unsigned request or an unknown key is rejected
  without a database read or write.
- `http://` is accepted only for `localhost`, so the two local instances this repo already
  supports — `npm run dev` on :8787 and `npm run dev:demo` on :8788, with separate
  databases — can connect to each other in development.

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
  (§9). B drops any cover URL that is not exactly that pattern on the connection's own
  origin, so a peer cannot make your pages load arbitrary third-party images.

Connection views and share links are **separate on purpose.** A share link is for anyone
holding the URL; a connection view is for households you've connected with. Publishing one
never publishes the other.

## 8. Feed

Nalanda has no event history today — items only have current state and `updated_at`.

- **Recording:** a new `activity_log` table filled by triggers in the new migration — after
  an item's `review`, `rating`, `status` or `completed_on` changes (and on insert with those
  set). Each row records the item, a kind (reviewed, rated, finished) and a timestamp; the
  activity JSON is built at read time, not in SQL. The triggers only write while
  `federation_settings` says federation is enabled.
- **Not logged in v1: "added to catalog."** A 2,000-book Goodreads import would bury every
  connection's feed. Bulk changes can still happen (an import that sets reviews), so the Feed
  page groups a household's events within a short window ("reviewed 40 books").
- **Pulled, not pushed.** `GET /federation/feed?since=<cursor>` returns that household's
  activities on items inside connection views, as ActivityStreams 2.0 JSON, plus anything
  addressed to the caller (§9, §10). Your instance fetches from each connection **when a
  member opens Feed or Loans**: cached results render immediately and the refresh runs in
  `waitUntil`. No cron, no background job.
- **Cost:** one subrequest per connection per refresh. The page refreshes at most a fixed
  number of connections per request and staggers the rest, staying inside the free plan's
  per-request subrequest limit.

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
  the comment is also listed in B's feed as addressed to A, so A collects it the next time
  one of A's members opens Feed or Loans. Pull is the guarantee; push just makes it fast.

## 10. Requests and lending

1. B browses what A put in connection views (`GET /federation/catalog`). Only items with
   `inCollection` and `available` both true can be requested.
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
   authenticated page load, and also listed in A's feed for B to pull.

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
| A stranger | fetch `/.well-known/nalanda` (household name, public key); POST `/federation/connect` | connecting needs an unguessable single-use token; throttled; no D1 write and no outbound fetch before the token check |
| Someone holding a leaked invite | redeem it once, within 7 days | it lands as pending; the admin sees the domain and declines; unused invites are revocable |
| A connected household | read your connection views and whether those books are available; comment; request | that is the feature; delete comments, decline requests, disconnect |
| A disconnected household | keep copies of what they already pulled | a well-behaved Nalanda deletes them; a modified one can't be forced to — **only connect with people you'd trust with a copy** |
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
- **Requests:** descriptor lookups and feed pulls between a handful of friends — noise
  against 100,000/day.

## 13. Data model — one new migration

| Table | Purpose |
|---|---|
| `federation_settings` | singleton: household name; enabled flag the triggers read |
| `connections` | peer base URL, public key, household name, status (pending, active, revoked), feed cursor |
| `connection_invites` | token hash, created by, expires at, used at |
| `connection_views` | captured filters, same shape as `shares`, visible to connections |
| `activity_log` | trigger-fed: item, kind, timestamp |
| `remote_activities` | cached feed from connections, unique on activity id |
| `remote_comments` | comments on our reviews, unique on activity id |
| `outgoing_activities` | comments, requests and return notices we sent, with delivery status |
| `borrow_requests` | both directions, with status |
| `connection_loans` | links an existing `loans` row to a connection and request |
| `borrowed_items` | books borrowed from connections |
| `federation_attempts` | per-IP throttle for `/federation/connect` |

All are appended to `scripts/backup.mjs`. Folding tables together (for example one
activities table with a direction column) is a reasonable call during the spike.

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
| Items in connection views (whitelisted fields) | existing tables; the JSON is built when requested, not stored | a cached copy in `remote_activities`, once pulled |
| Covers | R2 | not copied — B's pages load them from A's `/covers/<uuid>` |
| Activity events | `activity_log`: item, kind, timestamp only | cached in `remote_activities` |
| B's comment on A's review | `remote_comments` — authoritative | B's own copy in `outgoing_activities` |
| A borrow request | `borrow_requests` | `borrow_requests` |
| A's loan to B | an ordinary `loans` row plus a `connection_loans` link | `borrowed_items` |
| A's private key | Cloudflare secret — not in D1, not in backups | never |
| A's public key and address | served at `/.well-known/nalanda` | `connections` |

The consequence worth stating plainly: **anything B has pulled is a copy in B's database,
under B's control.** Disconnecting asks B's instance to delete it, and a well-behaved Nalanda
does; nothing can force a modified one to (§11). And because covers load from A, B's browser
contacts A's instance directly whenever it shows A's books.

## 14. HTTP surface — all new

```
public — no session; every route 404s while disabled
GET  /.well-known/nalanda           household name, public key, protocol version
POST /federation/connect            redeem an invite (token-gated, throttled)

signed by an active connection
GET  /federation/feed?since=        activities on items in connection views, plus items addressed to the caller
GET  /federation/catalog?since=     items in connection views, with availability
POST /federation/inbox              comments, deletes, borrow requests and responses, returns, disconnect

session — rendered only when enabled
GET  /connections                   admin: invites, pending, active, connection views, disconnect
GET  /feed                          members: connections' activity
GET  /borrowed                      members: books borrowed from connections
GET  /federation/export.json        members: federation data export
     plus a comments section on /items/:id and a requests section on /loans
```

## 15. Phases

Each phase ends usable. **A phase is done only when two real instances — :8787 and :8788 —
have been connected and the feature clicked through in a browser**, not when the suite
passes.

1. **Keys and connections.** Spike first: RFC 9421 profile CPU cost on workerd, ECDSA P-256
   versus Ed25519. Then keygen script, descriptor, invites, handshake with admin
   confirmation, disconnect, signature module with tests.
2. **Feed.** Connection views, `activity_log` triggers, feed and catalog endpoints, Feed page.
3. **Comments.** Both directions, deletes, pull fallback.
4. **Borrowing.** Requests, accept creates an ordinary loan, Borrowed page, return notices.

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

**Deferred — access control.** Who may confirm a connection (3) and choosing connection
views per connection (4) are left to a later role-based access design. ARCH.md §8 has two
roles and no permission matrix today, so that is its own decision rather than part of this
one.
