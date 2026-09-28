# Architecture — Nalanda

> **Status: approved & scaffolded (2026-07-03).** Named for the library of the Nalanda
> mahāvihāra. This doc is the source of truth for architecture decisions; CLAUDE.md holds
> day-to-day working conventions.

**Nalanda** is a self-hosted, libib-style library manager for the household: catalog **books, board games,
and vinyl records**, add items by scanning barcodes with a phone camera, auto-fill metadata
and covers, tag and rate things, track loans to friends, publish read-only shelves via share
links, and import/export everything as CSV.

## 1. Goals & constraints

1. **As close to $0/month as possible** — the driving constraint. Everything below fits
   Cloudflare's permanently-free tiers; the only optional cost is a custom domain (~$10/yr).
2. **Simple stack** — one language (TypeScript), one deployable (a single Worker), one
   database file's worth of state, no build pipeline beyond `wrangler` + `drizzle-kit`.
3. **Family use** — a handful of accounts (you + family), one shared catalog. Not a
   multi-tenant SaaS.
4. **Own your data** — full CSV export at any time, plain-SQLite database dumps, covers
   re-fetchable. Migrating away must never require reverse-engineering.

## 2. Stack at a glance

| Layer | Choice | Why |
|---|---|---|
| Compute | Cloudflare Workers (free plan) | 100k req/day free, free TLS, deploys in seconds |
| Framework | Hono + `hono/jsx` server-side rendering | Tiny, the de-facto Workers framework; JSX templates with zero extra tooling |
| Interactivity | htmx (vendored) + small vanilla JS | No SPA, no client bundler, no framework churn (see §17 for the full rationale) |
| Database | D1 (Cloudflare's SQLite) + **Drizzle ORM** | Free 5 GB; schema as TypeScript, typed queries, plain-SQL migrations out (§5) |
| Object storage | R2 for cover art | Free 10 GB, zero egress fees |
| Styling | Hand-written design system (`public/app.css`) | "Manuscript ledger" identity (§16 #16): palm-leaf/indigo/vermilion palette, Eczar display type, mono data type, dark mode — no framework, no build step |
| Barcode scanning | Browser `BarcodeDetector` API, ZXing-WASM fallback | Runs on the phone, costs the server nothing |
| Metadata | Open Library + Google Books (books) · BoardGameGeek (board games) · Discogs (vinyl) | All free — see §7 |
| Auth | Built-in multi-user (admin + members), WebCrypto PBKDF2 + signed session cookie | Family accounts with no email infra and no paid services (§8) |
| Dev/deploy | `wrangler dev` / `wrangler deploy` | Local D1+R2 emulation built in; no CI required |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` | Tests run inside the real Workers runtime |

Runtime npm dependencies: **`hono`, `drizzle-orm`, `fast-xml-parser`** (BGG's API is XML and
Workers has no DOMParser). htmx, the ZXing-WASM fallback and the Eczar fonts are vendored
static files in `public/vendor/`, copied in on install. Styling is the hand-written
`public/app.css` (§16 #16), no CSS framework. Dev-only: `wrangler`, `drizzle-kit`, `vitest`.

## 3. Why Cloudflare (and why not AWS or a home server)

- **AWS**: the useful free tiers (EC2, S3, API Gateway) expire after 12 months; the
  always-free path (Lambda + DynamoDB) forces NoSQL modeling and 3–4 services where
  Cloudflare needs one. Nothing here needs AWS, and not using it means nothing on it can
  surprise-bill. The account stays available if we ever need something CF can't do.
- **Home server / Raspberry Pi**: actually $0 forever, but you asked for a cloud provider —
  and CF gives free TLS out of the box, which matters because **camera access for barcode
  scanning requires HTTPS**.
- **Cloudflare's free tier is designed to stay free** at this workload's shape (see §12), and
  the whole app is one `wrangler deploy` away from running.

URL: lives at `https://<name>.<account>.workers.dev` for now; a custom domain later is a
one-line route change, no code impact.

Lock-in is the honest downside; §13 covers the exit strategy.

## 4. System overview

```
Family browsers (phone/laptop)          Share-link visitors (read-only)
  SSR HTML + htmx; scanner.js             GET /share/:token
  reads barcodes on-device                        │
        │ HTTPS (free TLS)                        │
        ▼                                         ▼
Cloudflare Worker — one Hono app (auth'd routes | public share routes)
  • pages & htmx partials (hono/jsx)   • /api/lookup, /api/import (JSON)
  • session middleware, roles          • CSV export, a page a request
        │                  │                        │
        ▼                  ▼                        ▼
       D1 (SQLite)        R2 (cover art)      Metadata APIs (outbound fetch,
       catalog + FTS5     served via Worker    only at add/import time):
                                               Open Library · Google Books
                                               BoardGameGeek · Discogs
```

No queues, no cron, no cache layer, no second service. The Worker is stateless; all state is
D1 + R2.

## 5. Data model

Schema is authored in TypeScript (`src/db/schema.ts`, Drizzle) and compiled by
`drizzle-kit generate` into plain SQL files in `migrations/`, which **wrangler** applies —
one migration runner, and the migration history stays readable SQL. The FTS5 table and its
sync triggers can't be expressed in Drizzle's schema DSL; they live in a hand-written custom
migration (`drizzle-kit generate --custom`). The SQL below is the canonical shape
(enum-style CHECKs are enforced at the TypeScript layer by Drizzle rather than in SQL):

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- 'pbkdf2$<iters>$<salt>$<hash>' (WebCrypto)
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  must_change_password INTEGER NOT NULL DEFAULT 0,   -- set on admin-created accounts
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE libraries (                 -- top-level collections, e.g. "Books", "Vinyl"
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  share_token TEXT UNIQUE,               -- NULL = private; random 128-bit = published (§9)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE items (
  id           INTEGER PRIMARY KEY,
  library_id   INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  media_type   TEXT NOT NULL DEFAULT 'book'
               CHECK (media_type IN ('book','boardgame','vinyl',
                                     'movie','music','videogame','other')),
  title        TEXT NOT NULL,
  creators     TEXT,            -- display string: authors / designers / artists
  isbn13       TEXT,            -- EAN-13 / ISBN-13
  isbn10_upc   TEXT,
  publisher    TEXT,            -- publisher / game publisher / record label
  published    TEXT,            -- fuzzy on purpose: '2019' or '2019-05-01'
  description  TEXT,
  length       INTEGER,         -- pages (book) / play-minutes (boardgame) / tracks (vinyl)
  cover_key    TEXT,            -- R2 object key (random UUID — see §9 on covers)
  status       TEXT NOT NULL DEFAULT 'not_started'   -- the household's, from everyone's reads (§16 #43)
               CHECK (status IN ('not_started','in_progress','completed','abandoned')),
  rating       INTEGER CHECK (rating BETWEEN 0 AND 10),   -- half-stars, rendered as 5 stars; the
  review       TEXT,                                      -- household's average and latest (§16 #43)
  notes        TEXT,            -- private notes — never rendered on share pages
  copies       INTEGER NOT NULL DEFAULT 1,
  began_on     TEXT,            -- status, began_on, completed_on, read_count, rereading and
  completed_on TEXT,            -- progress_page are derived from `reads` (§16 #41)
  read_count   INTEGER NOT NULL DEFAULT 0,  -- finished reads
  rereading    INTEGER NOT NULL DEFAULT 0,  -- finished before, and read again now
  details      TEXT NOT NULL DEFAULT '{}',  -- JSON: type-specific + unmapped import fields
  added_by     INTEGER REFERENCES users(id),
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_items_library ON items(library_id);
CREATE INDEX idx_items_isbn13  ON items(isbn13);

CREATE TABLE reads (             -- each time someone read an item: the source of reading state (§16 #41)
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('in_progress','completed','abandoned')),
  began_on   TEXT,              -- NULL = not known
  ended_on   TEXT,              -- finished or stopped; NULL while open, or not known
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reader_id  INTEGER REFERENCES users(id)   -- whose (§16 #43); NULL = a member removed since
);
CREATE UNIQUE INDEX reads_one_open_per_reader ON reads(item_id, reader_id) WHERE status = 'in_progress';
-- reading_progress (§16 #34) gains read_id → reads(id): each page belongs to a read, and to its reader

CREATE TABLE reviews (           -- each member's rating and review (§16 #43)
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL = a member removed since
  rating      INTEGER,          -- half-stars 1–10; NULL = not rated
  review      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT              -- when the text was last written: whose review the household shows
);
CREATE UNIQUE INDEX reviews_item_user ON reviews(item_id, user_id);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

CREATE TABLE loans (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  borrower    TEXT NOT NULL,
  contact     TEXT,
  loaned_on   TEXT NOT NULL DEFAULT (date('now')),
  due_on      TEXT,
  returned_on TEXT,            -- NULL = still out
  note        TEXT
);
CREATE INDEX idx_loans_item ON loans(item_id);

CREATE TABLE login_attempts (   -- login throttling (§8); old rows pruned opportunistically
  ip           TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Full-text search (D1 supports FTS5); kept in sync with items via triggers.
-- Lives in a hand-written custom migration alongside the drizzle-generated ones.
CREATE VIRTUAL TABLE items_fts USING fts5(
  title, creators, description, notes,
  content='items', content_rowid='id'
);
```

**`details` JSON — conventional keys per media type** (extended freely; unmapped import
columns also land here so imports are lossless):

- `book`: `{ subtitle, series }`
- any type: `{ reviewed_in: [url, …] }` — blog posts covering this item; owned by the
  dedicated "Reviewed in" form field, rendered as outbound links on item and share
  pages (a deliberate lightweight alternative to a posts table — the blog side holds
  the post→books direction).
- `boardgame`: `{ bgg_id, players_min, players_max, playtime_min, playtime_max, year }`
- `vinyl`: `{ discogs_id, format, label, catno, year, genres }` — format/pressing and
  catalog number are what collectors actually care about.

Reading and reviews are **per member** since 1.3.0 (§16 #43); they were one shared household
opinion in v1. Reading state lives in `reads`, one row per time someone read the item, and
ratings and reviews in `reviews`, one per member. `items.status`, `rating` and their
neighbours are the **household's summary** of them — Completed once anyone has finished it,
the average rating, the review written last — recomputed in the same batch as every write
(§16 #41, #43), so shelves, filters, share pages, connections and the export read one value
per item as they always have.

Sessions are **not** in the database: a signed (HMAC, WebCrypto) cookie carries
`{userId, expiry}`, verified per request against `SESSION_SECRET`, plus a cheap
user-still-exists check so removing a family member revokes access immediately.

## 6. Key flows

**Scan-to-shelf** (books & vinyl — the core experience):
1. `/add` opens the camera; `scanner.js` uses native `BarcodeDetector` where available
   (Chrome/Android), lazy-loads the vendored ZXing-WASM reader elsewhere (notably iOS
   Safari). Manual entry is always present as the universal fallback.
2. The scanned code routes itself: EAN-13 starting `978`/`979` → it's an ISBN → book
   providers; **any other EAN/UPC → Discogs barcode search** (record sleeves have barcodes
   and Discogs indexes them — this is the vinyl happy path).
3. `GET /api/lookup?barcode=…` runs the matching provider chain and returns normalized
   candidates (title, creators, publisher/label, date, cover URL, type-specific details).
4. Confirm screen pre-filled → on save, the Worker fetches the cover once, stores it in R2,
   inserts the item.

**Board games add by name**: BoardGameGeek's API has no barcode lookup, so board games use
the search tab — type a name, pick from BGG results (with player count, play time, year),
confirm. Same confirm screen, different entry point.

**Search-to-add**: same name-search flow works for books (Open Library search) and vinyl
(Discogs search) when there's no scannable barcode.

**Manual add/edit**: plain form, all media types, works from day one.

**Reading again**: a finished book's page offers "Read again", which opens a new read; the
book stays Completed, marked re-reading, until Finish or "Stop re-reading" closes it. Every
read is listed on the book's page, correctable and deletable (§16 #41). Each is its reader's:
the buttons act on the signed-in person's own reads, another member can start their first read
of a book someone else finished, and everyone's reading shows under their name (§16 #43).

**Lending**: from an item page, "lend" captures borrower + optional due date; dashboard and
`/loans` show what's out and overdue; "returned" stamps `returned_on`. History is kept.

**Publish a view**: admin publishes any filtered view of a shelf (or the whole shelf —
that's just a view with no filters) from the shelf page → each published view is a row
in `shares` with its own random token, name, and captured filters → `/share/<token>` is
a read-only, no-login page of exactly that view (§9, §16 #18). Rotate or remove any
link independently; old URLs die within a minute (§16 #19).

**Import from libib or Goodreads**: both export CSV. The import page parses the CSV **in
the browser** and posts JSON batches of ~200 rows (this sidesteps the Worker CPU budget,
§12); the format is auto-detected per batch (a Goodreads export always has an
`Exclusive Shelf` column). Known columns map to real columns; anything unrecognized lands
in `details` JSON so the import is lossless. libib rows always insert (`group` becomes a
tag). Goodreads rows **match-and-merge** (§16 #14): a row matching an existing item — by
ISBN-13, then ISBN-10, then normalized title + first-author surname — merges rating,
review, notes and shelves-as-tags onto it (Goodreads wins, but never blanks a field it has
no value for, and never touches copies or bibliographic metadata), and its shelf, Date
Read, Date Started and Read Count become reads, added and never removed (§16 #41);
unmatched rows insert with `copies = 0` (reading-log entries, §16 #13) unless Goodreads'
Owned Copies says otherwise. Re-runs are idempotent: previously inserted rows match on
the next run. A dry-run preview shows mapping + match counts before anything is written.
Everything a file brings is the importing member's — a Goodreads merge meets their own reads
and review only — except a Nalanda export, which names each read's reader and each review's
writer; a name that is a member here keeps them, and the preview says who gets what (§16 #43).
Export is the inverse: `GET /export.csv` writes every field back out, every read with its
reader included (`reads`, `read_count`), and every member's review (`reviews`) beside the
household's `rating` and `review`. The Export button
fetches it a page at a time and joins the pages in the browser, so no request builds more than
250 items (§16 #38); without a cursor the same route streams everything in one response.

## 7. Metadata providers

```ts
// src/metadata/provider.ts
interface MetadataProvider {
  id: string;                                    // 'openlibrary', 'discogs', 'bgg', …
  mediaTypes: MediaType[];
  lookupByBarcode(code: string): Promise<Candidate | null>;  // null if unsupported
  search(query: string): Promise<Candidate[]>;
}
```

| Provider | Covers | Key needed | Barcode? | Notes |
|---|---|---|---|---|
| Open Library | books | none | ✓ (ISBN) | default; covers via covers.openlibrary.org |
| Google Books | books | free API key (optional) | ✓ (ISBN) | fallback — coverage differs from OL |
| BoardGameGeek XML API2 | board games | **`BGG_TOKEN`** (free, registered app) | ✗ | XML (hence `fast-xml-parser`); name search + `thing` detail; `Authorization: Bearer` since BGG went registration-only in 2025 — 401 without it; be polite, BGG throttles |
| Discogs | vinyl (all music) | free personal token | **✓ (UPC/EAN)** | 60 req/min with token; returns format, label, catno |

- Providers are called only at add/import time — zero runtime dependency on them for
  browsing, and no background sync to burn anyone's quota.
- Secrets: `DISCOGS_TOKEN` and `BGG_TOKEN` (recommended — vinyl and board games need them),
  `GOOGLE_BOOKS_KEY` (optional) via `wrangler secret put`.
- Movies/CDs/video games: schema supports them (manual entry); TMDB/IGDB providers are v1.x
  **only if wanted** — deprioritized per review (§16).

## 8. Auth — family accounts

Multi-user, built into the app (no email infrastructure, no paid services):

- **First deploy** shows `/setup` (only while `users` is empty) to create the **admin**
  account (you). The admin and the three starter shelves are one batch (§16 #39), every
  statement guarded inside it by "no user yet", so two setups racing make one admin; the
  loser is sent to login.
- **Admin creates family accounts** at `/settings/users`: username + a temp password shown
  once; the member logs in and is forced to set their own password
  (`must_change_password`). No invites, no email, no reset flows — admin can re-issue a
  temp password the same way.
- **Roles**: `admin` = manage users + publish/unpublish share links; `member` = everything
  else (full item/library/loan CRUD). Two roles, no permission matrix. Reading and reviews
  are each member's own (§16 #43): a member changes only their own reads, pages and review,
  an admin anyone's, and only an admin moves one to another member.
- Items record `added_by`, so "who added this" is visible on the detail page.
- Password hashing: **PBKDF2-SHA256 (100k iterations) via WebCrypto** — native-speed, fits
  the free plan's CPU budget. Never bcrypt/argon2 npm packages (pure-JS, would blow it).
- Session: HMAC-signed cookie, `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day expiry; per
  request the middleware also confirms the user row still exists → deleting a user is
  instant revocation. Without a `SESSION_SECRET` (missing, empty or whitespace) nobody can
  sign in: `/setup` and login answer 503 with how to set one, before writing anything, and
  no cookie verifies — a blank key would sign cookies anyone could forge.
- CSRF: `SameSite=Lax` + an Origin-check middleware on all mutating routes.
- Login throttling: a per-IP counter of failed attempts in D1; ten in 10 minutes and login
  refuses that IP until they age out.

*Why not Cloudflare Access?* It was considered (free ≤ 50 users, zero auth code) but it
gates the whole hostname — which fights the public `/share/*` requirement — and it moves
auth into dashboard config that local dev can't reproduce. Built-in auth is ~150 lines,
portable, and makes share routes trivially public. CF Access remains available later as an
*extra* layer in front if ever wanted.

## 9. Public share links

- Publishing mints a `shares` row: a random 128-bit token plus the **captured filters**
  of the view being published (shelf, media type, status, owned) and a public name — or,
  published from a tag's page, a tag: everything carrying it, on any shelf (§16 #31).
  `GET /share/:token` (listing) and `GET /share/:token/items/:id` (item) render
  read-only pages with **no login**. The item route re-checks the item against the
  view's filters (`itemMatchesShare`) so a token can't be walked outside its scope by
  id. (`libraries.share_token` is legacy — migrated into `shares` by 0004.)
- **Field whitelist, not blacklist**: share pages render only title, creators, cover,
  publisher/label, published date, description, media details, tags, rating, review, and
  a derived boolean `inCollection` (`copies > 0`) so reading-log entries (`copies = 0`)
  carry a "Not owned" badge (§16 #13), and `readCount` — how many times the household
  finished it, only from twice on ("Read N times"), never the reads or their dates (§16 #41).
  The rating is the household's average and the review the one written last, with no author
  (§16 #43). **Never**: private notes, loans/borrowers, the copies count, added_by, usernames
  or anything else per member, or any nav into the authenticated app. The whitelist lives in
  one view module so it can't drift.
- **Who read what is never published.** The shelf's "Read by" filter isn't one of the
  filters a view captures, so no link can be made of it (§16 #43).
- **Reading progress is opt-in, household-wide** (`site_settings.progress_on_shares`, off by
  default, admin-only on **Shared links**). Even when on, only a book being read now — marked
  *in progress*, or finished before and being read again (§16 #41) — shows its page and bar,
  the latest page anyone reading it recorded (§16 #43); a
  finished book's last page is noise, an unstarted one has none — and the key is omitted
  entirely otherwise, so nothing downstream can render a stale value (§16 #34).
- Pages carry `<meta name="robots" content="noindex">` — links are for people you send them
  to, not search engines.
- Unpublish or regenerate the token any time; D1 stops being asked immediately, but an
  isolate that cached the page can keep serving it for up to an hour (the per-isolate
  page cache, §16 #19 — its TTL was raised from 60 s to one hour).
- **Covers**: share pages need cover images without auth, so `GET /covers/:key` is public
  with random-UUID keys (unguessable, no listing). Acceptable exposure: covers are public
  cover art by definition.
- **Front door (optional)**: with the `HOME_SHARE_TOKEN` secret set, anonymous `GET /`
  redirects to that share — the deploy's root doubles as the public library page
  (§16 #21). A stale token falls back to the login redirect.

## 10. HTTP surface

```
GET  /setup                    first-run admin creation (404 once a user exists)
GET  /login                    POST /auth/login · POST /auth/logout
GET  /account                  change own password (also the forced first-login flow)

GET  /                         dashboard: libraries, recent adds, loans out
                               (anonymous + HOME_SHARE_TOKEN set → 302 /share/<token>)
GET  /libraries/:id            item grid/list; filter/sort/paging via htmx partials
                               (?readBy= — "Read by", never publishable; §16 #43)
GET  /items/:id                detail  ·  GET /items/:id/edit
POST /items                    create  ·  POST /items/:id (update) · POST /items/:id/delete
POST /items/:id/progress       record a page · POST /items/:id/progress/:entry/delete
POST /items/:id/reads/start    open a read ("Read again") · POST /items/:id/reads (a past read)
POST /items/:id/reads/:read    correct · …/finish · …/stop · …/delete   (books; §16 #41)
                               · …/move (admins: to another member, with its pages; §16 #43)
POST /items/:id/reviews/:rev   edit · …/delete · …/move (admins)   — own review, or any for an admin
GET  /add                      add flow: scan | search | manual
GET  /api/lookup               ?barcode=… | ?q=…&type=boardgame → JSON candidates
POST /items/:id/loan           lend    ·  POST /loans/:id/return
GET  /loans                    out + overdue + history
GET  /search                   ?q= — FTS5 across title/creators/description/notes
GET  /tags · GET /tags/:id     browse by tag
GET  /import                   POST /api/import (JSON batches from client-parsed CSV)
GET  /export.csv               everything; ?library=:id to scope; ?after=:id for one page of 250
                               (x-export-next names the next page) — the Export button's way
GET  /covers/:key              cover art from R2 (public, unguessable, immutable cache)

GET  /settings/users           admin: create/remove members, reissue temp passwords
POST /shares                   admin: publish a view (captures shelf + filters + name)
POST /shares/:id               admin: action=rotate | delete

GET  /share/:token             public read-only library (whitelisted fields, noindex)
GET  /share/:token/items/:id   public read-only item detail

connections between instances — every route 404s without a federation key (§16 #29)
GET  /.well-known/nalanda       public: household name, public key, protocol version
GET  /connect                   public: explains an invitation link opened in a browser
POST /federation/connect        public, signed: redeem an invitation
POST /federation/inbox          public, signed by a connection: accept · decline · disconnect · comments
GET  /federation/views          signed by a connection: shared views, their size and recent volume
GET  /federation/feed           signed by a connection: activity in a view since a cursor
POST /federation/feed/check     signed by a connection: which stored entries are no longer shared
GET  /federation/outbox         signed by a connection: messages addressed to it, after a cursor
GET  /federation/shelf          signed by a connection: a page of a shared shelf, with availability
GET  /federation/item           signed by a connection: one shared item in full, with availability
GET  /connections              admin: name, invitations, pending and active connections
POST /connections/…            admin: settings · invites · redeem · confirm · decline · disconnect ·
                                views · follow · purge · unfollow
GET  /connections/:id/feed      admin: that household's shared views, what you follow, storage
GET  /feed                      members: activity from followed views, with comment threads
POST /items/:id/comments        members: reply in a connection's thread on one of our reviews
POST /feed/comments             members: comment on a connection's review we follow
POST /comments/:id/delete       members: delete our own comment, or any on our review
GET  /borrowed                  members: books borrowed from connections, requests, households
GET  /households/:id/…          members: a connection's shared shelves and items, read live
POST /households/:id/requests   members: ask a connection to borrow a book
POST /borrow-requests/:id/…     members: lend · decline (theirs) · withdraw (ours)
GET  /federation/export.json    admins: connections data as JSON
```

Every authenticated page route returns a full document normally and a partial when htmx's
`HX-Request` header is present — one handler, two renders, no client router.

## 11. Project layout

```
├── README.md · ARCH.md · CLAUDE.md · runbooks/
├── package.json · wrangler.jsonc     # bindings: DB (D1), COVERS (R2), assets: public/
├── drizzle.config.ts                 # out: './migrations' so wrangler applies them
├── migrations/                       # generated by drizzle-kit + custom (FTS5/triggers)
├── scripts/                          # vendor.mjs (postinstall), deploy.mjs, backup.mjs,
│                                     # wrangler-remote.mjs, seed-demo.mjs, backfill-remote.mjs
├── src/
│   ├── index.ts                      # Hono app: middleware (secure headers, origin check,
│   │                                 # session) + route order; admin checks live in routes
│   ├── routes/                       # items.tsx, libraries.tsx, loans.tsx, add.tsx
│   │                                 # (+ /api/lookup), share.tsx, shares.tsx, settings.tsx,
│   │                                 # auth.tsx, importexport.tsx, …
│   ├── views/                        # hono/jsx layout + components
│   ├── db/                           # schema.ts (Drizzle) + queries — only code touching D1
│   ├── metadata/                     # provider.ts + index.ts (chain/merge) + openlibrary.ts,
│   │                                 # googlebooks.ts, bgg.ts, discogs.ts, itunes.ts,
│   │                                 # musicbrainz.ts
│   ├── federation/                   # connections between instances (§16 #29)
│   └── lib/                          # auth.ts (pbkdf2, cookie), share.ts (public-field
│                                     # whitelist), csv.ts, covers.ts, reads.ts
├── public/                           # app.css, app.js, scanner.js, import.js, covers.js;
│                                     # vendor/ (htmx, zxing wasm, eczar fonts) is copied
│                                     # in on install and gitignored
└── test/                             # vitest, runs in workerd with real D1/R2 simulators
```

### Dev workflow & first deploy

- **Prereqs**: Node 22+ (the locked wrangler requires it; CI runs 22) and a Cloudflare
  account. `npm install` brings wrangler, hono, drizzle, vitest; a `postinstall` script
  (`scripts/vendor.mjs`) copies the vendored assets (htmx, ZXing-WASM, the Eczar fonts)
  from `node_modules` into `public/vendor/` so versions stay pinned in `package.json`.
- **Local dev**: `npm run db:migrate` once, then `npm run dev` — wrangler runs the Worker
  with a *local* D1 (a real SQLite file) and local R2; full offline loop, nothing touches
  the cloud. Local secrets live in `.dev.vars` (gitignored).
- **First deploy** (once; the full steps are in `runbooks/deploy.md`):
  1. `wrangler d1 create nalanda` (keep the database id it prints, for step 3) and
     `wrangler r2 bucket create nalanda-covers`. The id never goes into `wrangler.jsonc`:
     its `database_id` stays the all-zero placeholder (§16 #24).
  2. `wrangler secret put SESSION_SECRET` (plus `DISCOGS_TOKEN` for vinyl lookups,
     `BGG_TOKEN` for board game search, and optionally `GOOGLE_BOOKS_KEY`).
  3. `D1_DATABASE_ID=<id> npm run deploy` → resolves the id into a gitignored copy of the
     config, applies remote migrations, deploys, prints your
     `https://nalanda.<account>.workers.dev` URL. Visit `/setup`, create the admin
     account, start scanning.
- **Custom domain** (later): with the zone on Cloudflare, add it to the Worker under
  Settings → Domains & Routes — no code or config change. TLS stays free.

## 12. Free-tier budget — and how it shapes the design

| Resource | Free allowance | This app, realistically |
|---|---|---|
| Worker requests | 100,000/day | tens per day (+ occasional share-link visitors) |
| Worker CPU | **10 ms/request** | the binding constraint — see below |
| D1 | 5 GB · 5M row-reads/day · 100k row-writes/day | 10k items ≈ ~20 MB |
| R2 | 10 GB · 1M writes/mo · 10M reads/mo · **$0 egress** | 10k covers ≈ ~0.3 GB |
| Static assets | free, don't count as Worker requests | htmx/css/wasm |
| TLS + workers.dev subdomain | free | — |
| External APIs | OL keyless · BGG and Discogs free tokens (Discogs 60/min) · Google free quota | add-time only, single-digit calls |

The **10 ms CPU ceiling** is the one real constraint, and the design bends around it in
four places: CSV parsing happens in the browser (server just validates JSON batches);
CSV export is fetched a page at a time and joined in the browser (§16 #38);
cover images are stored as-fetched, never resized server-side; password hashing uses
WebCrypto (native) rather than a JS hashing library. Parsing one BGG XML response with
`fast-xml-parser` is sub-millisecond — fine. Everything else is I/O. Escape hatch if we
ever hit the wall anyway: Workers Paid is $5/mo and raises the limit to 30 s, with no
architecture change.

## 13. Backups & exit strategy

- `npm run backup` → `wrangler d1 export --remote` writes a plain `.sql` dump to `backups/`
  on your machine. Run it whenever; it's your library, keep copies.
- D1 Time Travel gives point-in-time restore as a safety net for oops-moments.
- CSV export from the UI at any time covers the data in app-agnostic form.
- Worst-case migration off Cloudflare: the dump is standard SQLite; Hono runs unchanged on
  Node/Bun/Deno; **Drizzle helps here** — it speaks `better-sqlite3` natively, so the port
  swaps the D1 driver for a file-backed one plus `src/lib/covers.ts` for the filesystem.
  Covers are re-fetchable from providers even if you skip copying the bucket.

## 14. Scope

**v1:**
multi-user auth (admin + family members) · libraries · items CRUD (every media type via
manual entry) · barcode scan with auto-routing (ISBN → books, other EAN/UPC → Discogs) ·
name search (Open Library / Google Books / **BGG** / **Discogs**) · covers in R2 · tags ·
ratings, reviews, status · loans · FTS5 search, filter, sort · **public share links per
library** · libib CSV import (lossless, dry-run) + full CSV export · cover and detail
backfill for imported items (client-driven batches, OL → Google Books → Discogs) · responsive UI
(phone-first for scanning).

**v1.x — candidates:**
~~per-member ratings/status~~ (done in 1.3.0, §16 #43) · stats page · bulk edit · TMDB/IGDB providers if movies/video
games ever matter · Cloudflare Access as an optional extra gate · custom domain hookup.

**Non-goals:** multi-tenant SaaS, native mobile apps, offline sync, public social features
or fediverse interop, ebook file hosting (calibre-web's territory), background jobs of any
kind. (Pairwise connections between two self-hosted instances are in scope — §16 #29.)

## 15. Risks

1. **Vendor lock-in (Cloudflare)** — mitigated by §13; accepted in exchange for $0/mo.
2. **10 ms CPU** — designed around (§12); $5/mo escape hatch exists and needs no rewrite.
3. **Metadata gaps** — Open Library coverage is imperfect (Google Books fallback);
   BGG has no barcode lookup (board games are name-search by design); Discogs needs a free
   token and throttles at 60/min (irrelevant at add-time volumes). Manual edit always works.
4. **BGG API quirks** — XML, occasional throttling/queueing; provider retries politely and
   the search flow tolerates a slow first response.
5. **iOS camera quirks** — `BarcodeDetector` is missing on iOS Safari; ZXing-WASM fallback
   plus manual entry keep the flow working.
6. **Share-link privacy** — public pages use a strict field whitelist (§9) and unguessable
   tokens; the residual exposure is anyone with the link can view that shelf — that's the
   feature.

## 16. Decision log

**2026-07-03 — initial review:**
1. Media types: **books, board games, vinyl records** → BGG + Discogs promoted into v1;
   TMDB/IGDB demoted to "if ever wanted".
2. URL: workers.dev subdomain for now; custom domain later (config-only change).
3. Access: **family multi-user** → built-in admin+members auth replaces single-user design
   (§8); Cloudflare Access rejected as primary (conflicts with public share routes).
4. Public read-only publishing: **promoted into v1** (§9).
5. Name: **Nalanda** — worker + D1 database `nalanda`, R2 bucket `nalanda-covers`.
6. ORM: **Drizzle adopted** — schema in TS, typed queries, generates plain-SQL migrations
   applied by wrangler; raw-SQL custom migrations for FTS5 + triggers (§5).
7. Rendering approach: **Hono SSR + htmx confirmed** over Next.js / Vite+React SPA (§17).

**2026-07-03 — after the first real import (315 books):**
8. Cover backfill shipped in v1: `POST /api/backfill-covers` walks coverless items in
   client-driven batches (same pattern as import, for the same subrequest/CPU reasons).
   Placeholder images are rejected: OL cover URLs use `?default=false` and `storeCover()`
   enforces a minimum size.
9. Backfill extended after the first run left 41 misses. Pass 1 (exact, by ISBN/UPC):
   OL search → OL edition record → Google Books → iTunes Search (keyless); Discogs →
   MusicBrainz/Cover Art Archive (keyless) for music barcodes. Pass 2 (title + author):
   OL/GB for books, BGG for board games, Discogs for vinyl — also covers items with no
   identifier at all. **Identity guards are mandatory for unattended matching** (learned
   live: a polluted-but-checksum-valid ISBN pulled a stranger's cover, and GB
   fuzzy-matches unknown ISBNs): a cover is stored only if the source's title matches the
   item (`titlesMatch`) or its identifiers echo the query, and title-pass candidates must
   also pass `creatorsMatch`. iTunes/MusicBrainz are cover-art-only helpers, not full
   metadata providers.

**2026-07-11 — production readiness:**
10. Backups are per-table, data-only exports (`scripts/backup.mjs`): D1 refuses to export
    any database containing virtual tables, so a whole-db dump is impossible with FTS5.
    Schema restores from migrations; the FTS index rebuilds via triggers on data insert.
    Rehearsed end-to-end (315 items, local → scratch instance), and the same procedure
    doubles as the local→production data migration (deploy runbook).
11. Hardening: `secureHeaders()` (no CSP — inline onsubmit confirms), `robots.txt`
    disallow-all (share pages already carry noindex), logo + PWA manifest + icons so the
    app installs to phone home screens (relevant: the barcode scanner).
12. Referrer policy must never be `no-referrer` (learned live: it broke every login):
    browsers apply referrer policy to the **Origin** header too, sending `Origin: null`
    on same-origin form posts, which our own CSRF check then rejects. Policy is
    `strict-origin-when-cross-origin`, and the CSRF middleware now checks
    `Sec-Fetch-Site` first (immune to referrer policy) with the Origin comparison as the
    legacy fallback. Regression-tested with browser-faithful headers (test/csrf.spec.ts).

**2026-07-18 — reading log (Goodreads redundancy, phase 1):**
13. **`copies = 0` means "in the catalog, not in the physical collection"** — the
    representation for reviewed/rated books that were never owned (Goodreads history,
    library loans, borrowed books). Chosen over a new `ownership` column (the count
    already expresses it, and export/import round-trips it with zero new surface) and
    over a separate "reading log" library (a book you later buy shouldn't have to move
    shelves). Consequences: lending is blocked at `copies = 0` (UI + server), the
    library view gains an owned/not-owned filter, and the dashboard "Items" stat counts
    owned only, with a separate "Read, not owned" stat. Share pages *include* these
    items — deliberate: share links double as the public reviews page — badged via a
    whitelisted derived boolean (`inCollection`); the raw count stays private (§9).
14. **Goodreads CSV import is match-and-merge**, not insert-only like libib (§6): match
    by ISBN-13 → ISBN-10 → normalized title + first-author surname (series suffixes,
    subtitles, and initials-spacing stripped — Goodreads titles carry "(Series, #1)"
    that provider-sourced titles don't). On match, **Goodreads wins** for rating,
    review, status, read date, private notes (user's call — Goodreads is the current
    source of truth), but absent values never blank existing ones and copies/metadata
    are untouched. Ratings map 0–5 whole stars → half-star scale ×2 (0 = unrated);
    `Exclusive Shelf` → status (read/currently-reading/to-read, custom dnf/abandoned
    shelves → abandoned); ISBNs are unwrapped from Excel guards (`="…"`). Format is
    auto-detected server-side per batch, so /api/import needs no format flag and the
    same endpoint serves both importers. *Amended by #41:* status and the read date now
    arrive as reads, which a merge adds and never removes — Goodreads still wins for
    rating, review and notes.
15. **"Log — not owned" on scan/search results** — the ongoing Goodreads replacement:
    every add-flow candidate card gets a second submit that presets `copies = 0` and
    redirects to the edit form (not the detail page) so rating/review/status/read date
    go in immediately. Same `POST /items` handler, one extra form field.
16. **Visual identity re-grounded in Nalanda itself: "the manuscript ledger."** The
    accession-ledger bones stay; the materials become the Pala-era scriptorium's:
    palm-leaf buff paper, lampblack ink, **indigo** working accent, **vermilion**
    rubrication (red stays reserved for circulation/danger, exactly as red ink marked
    critical annotations in the manuscripts), turmeric gold for ratings; dark mode is
    the lamp-lit reading room (warm blacks). Display face is **Eczar** (OFL,
    Devanagari-first design), vendored as woff2 via `@fontsource/eczar` +
    `scripts/vendor.mjs` — never a CDN. Signature: the **śirorekhā** — the brand's
    vermilion double rule sits *above* the wordmark, which hangs from it like
    Devanagari letters from their headstroke; नालन्दा appears in the brand sub-line
    and share footer (system Devanagari fonts, graceful fallback). Logo, PWA icons,
    manifest, and theme-color metas follow the new palette. The faintest ink, `--ink-3`,
    was deepened to `#746b58` (light) and `#8f846d` (dark) so the 10–11px mono labels it
    carries clear 4.5:1 on paper.
17. **Mark: Ratnodadhi in brick.** The logo is Nalanda's nine-storey library tower
    ("Ocean of Jewels") as it stood — red-brick storeys on palm-leaf buff, turmeric
    jewel at the summit, lampblack plinth. Chosen over an indigo-ground version (the
    app's *perceived* scheme is paper + red, indigo is seasoning) and over letterform
    marks (Latin N, Devanagari न — rejected as not saying "library"). The exploration
    lived in `options/`, untracked when the repo went public (#24) — eight studies for a
    settled decision are clutter in a public tree; they remain in git history and on the
    maintainer's disk. Regenerate icons from `public/logo.svg` via qlmanage + sips.
18. **Share links are per-view, not per-shelf.** New `shares` table: token + name +
    captured filters (shelf, media type, status, owned) + sort; a whole-shelf link is
    simply a filterless view. Any number of links per shelf, rotated/removed
    independently; the public item route enforces the view's filters so ids can't be
    walked out of scope. Existing shelf tokens migrated in (0004) so published URLs
    survived; `libraries.share_token` remains as a dead column (append-only
    migrations, no destructive change). 0003 is an intentional no-op — it was
    recorded as applied while still empty, and the harness requires ≥1 statement.
19. **Share pages are burst-shielded by a per-isolate memory cache** (TTL 1 h,
    raised from the initial 60 s by owner's call — public pages change rarely).
    They are the many-readers surface and D1's read quota is shared with the
    authenticated app — a hot link must not degrade the household's own use.
    Mechanism chosen over (a) edge Cache API / `s-maxage` — a **no-op on
    workers.dev domains** (no zone; becomes a worthwhile second layer if a custom
    domain lands) — and over (b) materializing view JSON to R2 — write
    amplification (every edit fans out to every affected view × page), unbounded
    staleness on any missed invalidation hook, and a second data store violating
    the D1-as-only-source invariant. **Writes invalidate, coarsely**: any
    successful mutation clears the handling isolate's cache (index.ts →
    `clearSharePageCache()`), so the household's own edits go public immediately;
    untouched isolates converge within the TTL or on eviction. Accepted cost of
    the long TTL: a rotated/removed link can keep serving from an untouched
    isolate for **up to an hour**. `x-cache: hit|miss` header aids debugging;
    hit/miss/bust regression-tested in test/items.spec.ts.

**2026-07-19 — went live:**
20. Production provisioned and deployed. D1 `nalanda` + R2 `nalanda-covers` created via
    wrangler; full local catalog migrated (per-table SQL restore — FTS rebuilt itself
    via triggers — plus all cover objects copied key-for-key out of miniflare's local
    store, so no production backfill was needed). Deploys run through the Cloudflare
    dashboard git integration: push to `deploy-site` → `npm run deploy`. Two live
    lessons: an empty `SESSION_SECRET` throws `DataError` on HMAC import at login (the
    Worker boots fine — set the secret before first login; since 1.3.0 setup and login
    refuse a missing or blank secret up front and say how to set it, §8), and
    dashboard-pasted secret values can pick up whitespace (piping the value into
    `wrangler secret put` is the reliable path). Local reminder: miniflare keys local D1 state by `database_id`, so
    changing the id in `wrangler.jsonc` orphans local data until the state file is
    copied to the new key.
21. **Front door via `HOME_SHARE_TOKEN` (optional secret).** The app lives on a
    subdomain whose root should greet guests, not a login form: with the secret set,
    anonymous `GET /` 302s to `/share/<token>`; signed-in users still get the
    dashboard. Config-as-secret chosen over a DB flag (no migration or admin UI for
    a single-household setting; repoint with `wrangler secret put HOME_SHARE_TOKEN`,
    which applies immediately and survives deploys) and over a Cloudflare edge
    redirect rule (hardcodes a token outside the app — rotation would 404 the front
    door). The token is validated per request, so a stale value (share rotated or
    deleted) degrades to the normal login redirect. Share pages still carry no links
    into the authenticated app; the household signs in at `/login` directly.
22. **Shelf filters are any-of checkbox groups** (type, status, holding), not
    single-value selects: params repeat (`?type=book&type=vinyl`), `listItems`
    takes arrays (`inArray`), values OR within a dimension, dimensions AND
    together. "Holding" is two checkboxes (Owned / Logged — not owned) over the
    same tri-state `owned` param: exactly one checked filters; both or neither
    means no filter — old single-value URLs keep working. The `shares` schema
    still captures **one value per filter**, deliberately: public views should
    be simple, stable scopes, and widening those columns to arrays would ripple
    through `itemMatchesShare` for no household need. "Publish current view"
    captures a dimension only when exactly one value is selected; the preview
    line states that a multi-selection publishes as "all".
23. **"What is public" is a screen, not a badge.** Decision #18 made shares
    per-view, but the UI kept a per-shelf mental model: any share row on a shelf
    rendered it SHARED, and the links themselves lived inside each shelf's
    settings `<details>`. Both understate and scatter the thing that matters —
    publishing is the only way data leaves this app. Now `shareVisibility()`
    distinguishes a filterless link (the shelf entire → *Shared*) from captured
    ones (a slice → *"2 views shared"*), and `/shares` lists every published
    link across all shelves with its scope, live item count, URL, and
    rotate/remove. The per-shelf panel stays as the place to *publish* (it needs
    the shelf's current filters); `/shares` is the place to *review*. The count
    comes from `countMatchingItems()` + `shareFilters()` — the same WHERE the
    public page runs, so the number can't drift from what the link exposes.
    Admin-only, like every other share mutation.

24. **No Cloudflare resource ids in the repo.** Going open source, `wrangler.jsonc` keeps
    an all-zero placeholder `database_id` and `npm run deploy` (`scripts/deploy.mjs`)
    resolves the real id from `D1_DATABASE_ID` into a gitignored copy of the config. The
    id is not a credential — it is inert without account access — so this is hygiene, not
    a secret fix: a public repo should describe how to run *an* instance, not point at
    one. Wrangler does not interpolate environment variables inside its config (a literal
    `${VAR}` is sent to the API verbatim — verified), hence the resolved copy; it lives in
    the project root because wrangler resolves `main`, `assets`, and `migrations_dir`
    relative to the config file's own directory. The placeholder must stay a well-formed
    UUID — `wrangler dev` rejects an empty string — and it is load-bearing for local
    storage keying (#20), so editing it orphans an existing local database. Local dev,
    migrations, and tests all run against the placeholder, so a clone needs no edit at
    all. The same pass added LICENSE (MIT), CONTRIBUTING, SECURITY, THIRD-PARTY, CI, and
    CODEOWNERS, and untracked `options/`.

25. **The test harness follows vitest-pool-workers, and owns its own fetch mock.** The
    v0.8 → v0.20 jump (forced by wrangler 4.119 peering on workers-types v5) removed four
    things at once: `defineWorkersConfig` and the `/config` export (now a plain Vitest
    config plus a `cloudflareTest()` plugin), `ProvidedEnv` (now `Cloudflare.Env` by
    declaration merging in `test/env.d.ts`), automatic per-test isolated storage (now an
    explicit `reset()`, so `test/apply-migrations.ts` wipes and re-migrates before every
    test — the suite assumes a clean catalog, e.g. `holdingsByType` counts globally), and
    `fetchMock`, which vanished from both `cloudflare:test` and miniflare 5.
    `test/fetch-mock.ts` replaces it with a global `fetch` stub — viable because the pool
    runs the worker under test in the *same isolate* as the test — and deliberately keeps
    the two properties that made the original trustworthy: an unmatched request throws
    rather than reaching the network, and unconsumed interceptors fail the test. Bundled
    codemod not used: it only rewrites the object form, and ours builds migrations async.
    Lesson recorded in `.github/dependabot.yml`: group minor/patch, never majors.

26. **Dismissed: GHSA-67mh-4wv8-2f99 (esbuild dev server), tolerable risk.** The advisory
    lets any website read source off `esbuild --serve`. Not reachable here: nothing in
    this project invokes esbuild directly — it is a bundler *library* under wrangler,
    vitest and drizzle-kit, and both dev servers (`wrangler dev`, the vitest pool) serve
    through workerd/miniflare, so esbuild's HTTP server never starts. Development scope,
    so it never enters the Worker bundle either. Unfixable by upgrading: the vulnerable
    copy is `esbuild@0.18.20`, pinned four levels down by
    `drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils`, a package
    deprecated in favour of `tsx` that will not ship a fix — the tree's other three
    esbuild copies are already patched. An `overrides` pin was rejected as more likely to
    break drizzle-kit's loader than to prevent anything. Revisit if this project ever
    runs esbuild's server directly, or when drizzle-kit drops the `@esbuild-kit` chain.

27. **Holding is its own column, and its toggle spans only 0 ↔ 1.** "Not owned" used to
    ride along beside the status pill; it is now a Holding column in the shelf table and a
    Holding row on the item page, so ownership reads separately from progress. The pill is
    a one-click htmx toggle (`POST /items/:id/mark-owned` and `/mark-not-owned`, each
    swapping itself for the other direction) — the common move is a logged book arriving
    on the shelf, and that shouldn't need the edit form. **The toggle deliberately refuses
    items held in 2+ copies**: it can only land on 0 or 1, so offering it there would
    silently discard a recorded count, and `copies` round-trips through `/export.csv`
    (§12). Those render a plain `N copies` pill, and the route returns that untouched
    rather than zeroing — the guard is server-side, not just a hidden button. Grid cards
    keep the non-interactive pill: they sit inside the card's own link, and nesting a
    button there is invalid HTML. Share pages are untouched — they use the plain
    `NotOwnedPill`, never `ItemTable`, so no mutation control or authenticated-app link
    can reach a public page (§9).

28. **Table columns are a per-device choice, kept in localStorage.** The shelf table
    reached ten columns, and one fixed set cannot serve three media types — a vinyl shelf
    has no use for "Completed", a board-game shelf would rather see play time than Year.
    A "Columns" dropdown (the existing `FilterMenu` pattern, so it looks native) toggles
    everything except Title, which stays so a row remains identifiable. **The server always
    renders every column**; hiding is presentational only, via `col-*` classes and a
    `data-hide-cols` attribute on `<html>` — so with JS off you get the full table rather
    than a broken one, and htmx swaps can't lose the setting. The attribute is applied by
    a small inline script in `<head>` rather than deferred `app.js`, or the full table
    would paint before columns visibly vanished. Storage is deliberately **not** the
    server: this is display preference rather than catalog data, it wants to differ
    between a phone and a laptop, and putting it in D1 would mean a migration and a write
    on every toggle for something that matters to one browser. The checkboxes carry no
    `name`, so they never join the surrounding GET filter form.
29. **Connections between self-hosted instances — approved, built in phases.** Two households
    that both run Nalanda can connect by invite, then see a feed of each other's reading,
    comment on each other's reviews, and borrow from each other. This reverses the "social
    features" non-goal in §14 deliberately and narrowly: connections are strictly pairwise,
    never a network, with no fediverse interop. ActivityPub was rejected because its value is
    reaching the wider network, and its open inbox is exactly where its spam problem lives.
    Instead: invite-only connections confirmed by an admin, RFC 9421 HTTP Message Signatures
    on every later request, and ActivityStreams 2.0 as the JSON format — with no new
    Cloudflare products and no new runtime dependency. "Background jobs of any kind" stays a
    non-goal: pulls happen only when someone opens a page. Additive by construction — off
    unless the instance has a federation key. The design, decisions and threat model live in
    `docs/proposals/connections.md`; each phase's pull request updates it where the build
    has to differ.

30. **Fixed: GHSA-rgj7-g3m4-5g8c (sharp, via libheif), with an `overrides` pin.** sharp
    0.35.2 bundles a libheif whose image decoders have critical bugs; 0.35.4 carries the
    fixed libheif. Not reachable here: sharp arrives only as a development dependency of
    miniflare, which imports it lazily to emulate the Images binding — and Nalanda has no
    Images binding (a paid Cloudflare feature this project rules out) and processes no
    images anywhere, so nothing ever hands sharp an image. Unlike #26, though, the fix is
    cheap. miniflare pins sharp exactly, and wrangler and vitest-pool-workers share one
    miniflare: wrangler ≥ 4.131 has moved to 0.35.4, but the newest vitest-pool-workers
    (0.22.0) still pins 0.35.2, so no version bump clears the tree. `"overrides":
    { "sharp": "0.35.4" }` in `package.json` replaces every copy; the lockfile changes only
    sharp and its prebuilt libvips packages, and the suite passes. **Remove the override**
    once vitest-pool-workers ships a miniflare that pins sharp ≥ 0.35.4 itself — left in,
    it would hold sharp back the next time miniflare moves.

31. **Share links can capture a tag.** Shelf filters can't express a hand-picked list —
    "the books I've reviewed on my blog", or a Goodreads shelf like "to-read-2020" that
    arrived as a tag — and a book lives on exactly one shelf, so a shelf can't serve as that
    list without pulling books out of the shelf they belong to. `shares.tag` (migration
    0011) publishes everything carrying the tag. Such links are published, rotated and
    removed on the tag's own page and span every shelf (`library_id` null), owned or not.
    Scope is enforced in both places, as before: `shareFilters()` adds an `EXISTS` over
    `item_tags`, and `itemMatchesShare()` now takes the item's tags, so the public item
    route loads them before deciding. A tag link never counts as exposing a shelf entire.

32. **The backfill fills details, not just covers.** A catalog imported from Goodreads or libib
    arrives without descriptions too, and the record that yields a cover usually carries the
    description, publisher, year and page count — Google Books especially, which is why
    `GOOGLE_BOOKS_KEY` earns its keep for a bulk run: the keyless quota is shared and answers 429
    under load. `findCover()` now returns the record it matched, and keeps a match even when no
    image can be stored, so a coverless hit still yields details. The queue widened from "no
    cover" to "no cover or no description". Only blank fields are filled — never what the
    household wrote — and an item that already has a cover keeps it (nothing is even fetched for
    it). One item's failure no longer ends the run: each is caught, the batch reports the progress
    it made, and the browser resumes past it. Batch size dropped 4 → 3, because a full-chain miss
    can spend ~9 subrequests per item against the free plan's 50.
33. **Bulk backfills run from a laptop, using the app's own matching code.** On a 2,000-item
    catalog the in-app backfill kept tripping the free plan's per-request limits. First it was
    parsing Open Library's full ISBN lists: cover lookups now ask for a lean field set, which cuts
    a search from 70 KB to 15 KB, and the batch is 2. Even after that, an occasional request still
    failed. `scripts/backfill-remote.mjs` runs the same `src/metadata` under Node, using Node's
    native type stripping plus a resolve hook for our extensionless imports, so no bundler and no
    new dependency. It paces each provider (Open Library refused this IP's connections at 14
    concurrent) and gives each request its deadline only once its turn comes. It stops rather than
    record a miss when a provider keeps failing. Covers go into R2 before any row points at them.
    It writes only blanks, each UPDATE re-checking its own field; text goes in as
    `CAST(X'…' AS TEXT)`, so quotes and semicolons can't break the SQL file. `rehearse` runs all of
    it against a throwaway local database and checks the outcome. The in-app backfill stays, for
    small top-ups.
34. **Reading progress is a log, not a number.** "Page 187" on its own answers where you are;
    the reading log answers how the book has been going, which is what a Goodreads-style progress
    update is really for — so `reading_progress` keeps one row per update and `items.progress_page`
    carries the latest, denormalised, because a shelf row can't afford a subquery per item under
    the 50-query budget. Recording a page starts the book (`not_started` → `in_progress`, and
    `began_on` if it was empty), because recording a page is what starting a book looks like; an
    explicitly set status or date is never touched. Deleting an entry recomputes the latest page but
    leaves status and `began_on` alone — a mistyped page is not a claim the book was never opened.
    Pages aren't capped at `length`: provider page counts are routinely wrong, so percentages clamp
    at 100 instead of refusing a real page number. Books only. Both the latest page and the whole log
    leave through `/export.csv` (`progress_page`, and `progress_history` as `page@timestamp` pairs);
    neither libib nor Goodreads exports progress, so there is nothing to map on import. On share
    pages it is an admin's choice, off by default — how far through a book someone is reads more
    like a private note than a published review, but some households want a public "reading now"
    — stored in a single-row `site_settings` table whose missing row means every default, so a
    fresh instance needs no setup (§9). It reaches connections separately, as feed entries (§16 #35).
    *Amended by #41:* a page belongs to a read and goes only to an open one — a finished book takes
    none until "Read again" — and `progress_page` is the current read's latest.
35. **Progress reaches connections as a timeline: every update its own feed entry.** The
    household chose that over "latest progress per book". `activity_log`'s (item, kind)
    uniqueness became partial (`WHERE kind <> 'progress'`) so progress accumulates while 0007's
    `INSERT OR REPLACE` still collapses reviews, ratings and finishes — a test proves both. An
    entry points at its update through `progress_id`, so it carries the page it recorded, not
    where the book is now. That column has no `ON DELETE CASCADE`: drizzle-kit silently drops
    the clause when adding a column by `ALTER TABLE`, and D1 enforces foreign keys, so
    `deleteProgress()` deletes the entry itself, first (the test fails with "FOREIGN KEY
    constraint failed" without that). Sharing is on by default and a household-wide switch on
    Connections; switching it off stops new entries and, through `stillShows`, withdraws sent ones
    by the ordinary removal check. Older peers skip the unknown kind and keep going, because
    `parseFeedPage` drops unparseable entries rather than the page. On the Feed page a book's
    updates gather in its card as a timeline instead of each taking a card, keeping "one card per
    book per household"; "reading" gives way to "finished" once it is. Every entry counts against
    the receiver's `maxEntries`, so a busy reader's updates can push older entries out of a
    connection's stored feed — the receiver's cap, chosen by the receiver.
36. **Notifications are in-app, per person, and only about connections.** A household redeemed an
    invitation and nothing told anyone to confirm it. Push was considered and set aside — a service
    worker, VAPID keys and a subscriptions table for a household app that's checked daily. Stored
    notifications cover the discrete events someone may need to act on or would want to know:
    connection requested, accepted, declined, withdrawn, disconnected; a borrow requested,
    withdrawn, accepted, declined, returned; a comment. Each is recorded behind the check that
    proved the event happened — the `federation_seen` replay marker, `setRequestStatus`'s return,
    `insertComment`'s conflict — so a message replayed from an outbox notifies once. And each is
    written in the same batch as its change, on the change's own precondition (`notifyIf`): as two
    calls, an outbox pull that ran out of budget between them kept the change, and the replay —
    seeing it made — skipped the message, so its notification never came. The same failure hit
    whatever went before its effect: a connection message's replay marker was written first and
    alone, so a failure after it turned the retry away as "already processed" with nothing done,
    and a redeemed invitation that failed to notify left a request no admin was told about. The
    marker, the effect and the notice are now one batch (`applyConnectionMessage`, `redeemInvite`).
    Names and titles are copied in,
    so a notification still reads after a disconnect, and render as escaped text; `href` is always
    built here. Connection kinds reach admins only, since only admins can act on them. Feed activity
    is counted, not notified — a notification per progress update would bury everything else.
    Read state is per person as an id watermark (`notifications_seen_id`, `feed_seen_id`), not a
    time: the Feed page pulls after it responds, usually inside the same second, and a time marker
    would count what that pull brings in as seen. The page marks the feed seen *before* starting
    its pull, in one statement, and marks notifications up to the newest one shown, not "now". One
    extra query per page, only on an instance with connections. On a phone the sidebar folds away,
    so the mobile bar carries its own badge. `remote_activities.id` was a plain rowid, so when the
    newest stored entry was withdrawn the next one could reuse its id and fall below a reader's
    watermark; migration 0019 rebuilds the table with AUTOINCREMENT (hand-written — drizzle-kit wraps
    rebuilds in PRAGMA foreign_keys, which D1 doesn't honour in a migration; nothing references the
    table, so the drop is safe with foreign keys on). Kept six months. Migrations 0016–0018 (0017/0018
    replace 0016's first-draft time columns; drizzle-kit can't answer its rename prompt
    non-interactively, so the swap is a drop then an add).

**2026-09-28 — measured, not assumed:**
37. **The D1 limit that binds is 1,000 calls per invocation, and a batch is one call.** Every
    design since the connections build assumed the documented free-plan figure — 50 queries per
    invocation, each statement in a `batch()` counting separately. Production imports running
    ~300 statements per request contradicted that, so a throwaway Worker with its own empty D1
    database measured it: 1,000 separate `SELECT 1` calls in one invocation passed and the
    1,001st failed ("Too many API requests by single Worker invocation"); a single 2,000-statement
    batch passed; 1,001 two-statement batches failed on resources (1102), not on the count. The
    probe was deleted afterwards and never touched Nalanda's data. Designs keep 50 as their
    budget — conservative, and possibly what binds on another account — but a batch is no
    longer counted per statement.
38. **CSV export is fetched a page at a time, and the browser joins the pages.** The export
    streamed the whole catalog from one request, and a stream's work all counts against that one
    invocation's 10 ms of CPU. The pre-deploy review estimated 15–20 ms for production's 1,998
    items; timing the real `pageItems` and `itemToCsvLine` in V8, on rows heavier than production's,
    gave 12 ms warm and 20 ms on a cold isolate for 2,000 items, 1.8 and 6 ms for 250. So the
    Export button asks for `/export.csv?after=<id>`: one page of 250 items a request, the header row
    on the first page only, and `x-export-next` naming where the next starts until a page comes
    back short. `public/import.js` joins the pages into one Blob and saves it under the filename
    the first page names. A page that fails fails the export, and nothing is saved, and a lapsed
    session can't slip the login page into the file (`redirect: 'error'`, and each page must be
    `text/csv`). Imports already worked this way round, in 200-row batches. The route without a
    cursor still streams everything in one response: what the link does without JavaScript, and
    what a script fetching the URL gets. On a large catalog the runtime can cut that off, and the
    download then fails rather than stopping short. Workers Paid's 30 s would have made the stream
    enough on its own, but this app stays on the free plan.
39. **A change and whatever it owes — a message, a notification, a replay marker — are one
    batch.** Two pre-deploy reviews proved the same failure in a dozen places: a write, then a
    second write that depends on it, as separate D1 calls. A failure between them — a transient
    D1 error, an exceeded CPU limit, or an outbox pull out of budget — kept the first alone, and
    the path's own idempotency check then treated the job as done: a comment stored here, never
    sent, and doubled on a second Send; a lend or a decline the other household was never told
    about; a notification that never came; a connection message whose replay marker turned every
    retry away. Now the message is queued in the same batch as its change (`queueWith`), only
    while the change's own precondition holds, and the change runs only once the message is in
    the outbox — a fresh activity id makes that exact, and lets lending pick up its new loan's
    id inside the batch. A borrow request is queued only while none for that book is waiting, so
    a double submit makes one request. Notifications ride along the same way (`notifyIf`), and so do replay
    markers (`applyConnectionMessage`). Anything after the batch — the push, a prune — must be
    unable to fail the request, or the person's retry repeats a change already made. Drizzle's
    batch can't take raw SQL with parameters, so batches that need both are built as plain D1
    statements (`statement()`).
40. **Feed activity is dated by when it happened, and an import isn't news.** The first-view
    backfill dated entries by `items.updated_at`, and a Goodreads import (all 1,998 items on one
    day) and two metadata backfills had rewritten that on every item within the 90-day window, so
    sharing a first view would have offered followers the newest 300 of years of reviews, ratings
    and finishes as if they were new. The triggers had the same flaw from the other side: `at` was
    always now, so a 2019 read imported while a view was shared reached followers as today's
    finish. Receivers sort by the entry's date and keep only their retention window, so the fix is
    the date itself. The backfill takes only activity with a date of its own: a finish by its
    `completed_on`; a rating or review, which has no timestamp, by its book's `completed_on` —
    and one without is left out, since nothing else says when it was given (`added_at` doesn't:
    Goodreads' "Date Added" lands in `details`, so imported items are added the day of the
    import). Progress keeps its own time, and an update already in the log isn't added again.
    The triggers (migration 0021) date a finish by `completed_on` when that's before today, and a
    rating or review by now: re-rating a book read years ago is news the day it happens. Only an
    import can't be told from that by the data, so an import says so: its batch inserts a row in
    `import_in_progress` first and deletes it last, and while the row exists all three kinds are
    dated by `completed_on`, clamped to now, and a read with no usable date records nothing. One
    batch, so the marker can't outlive the import or miss a row of it; a failed import rolls it
    back with everything else. Considered and set aside: dating ratings by `completed_on` always
    (buries genuine re-ratings), and suppressing everything during imports (loses a read finished
    last week and imported today, which is news). A new follower's first page is the newest by
    date, not by id, since an import's old reads now carry new ids and old dates; its cursor is the
    highest id it sent. The first view and its opening entries are one batch. Deleting the last view clears the log in the
    same batch, so a stale log can't survive to the next first view.

**2026-09-28 — reading a book again:**
41. **Each read of a book is a row, and a re-read keeps the book Completed.** A book had one
    status and one pair of dates, so reading it again overwrote the first read, and nothing
    counted reads. `reads` now holds one row per read — status (`in_progress`, `completed`,
    `abandoned`), began, ended — with at most one open read per item (a partial unique index).
    It is the source of truth; `items.status`, `began_on`, `completed_on`, `progress_page` and
    the new `read_count` and `rereading` stay as a cache of it, because every shelf, filter,
    share view, connection view, trigger and the export already read those columns and a shelf
    can't afford a subquery per item. One statement, `refreshReadState()`, derives them, and
    rides in the same batch as every write to reads (#39); `summarizeReads()` is its TypeScript
    twin for inserts, and a test holds them together. **The owner chose that a re-read keeps
    the book Completed** (over moving it to In progress, and over making Completed filters
    match anything ever finished): status comes from the last finished read if there is one,
    else the open one, else the last stopped one, so nothing moves between status-filtered
    views — shelves, share links, connection views — while a book is read again. `rereading`
    (an open read on a finished book) marks it instead, as a dashed indigo pill wherever
    status shows; `began_on` and `completed_on` stay the last finish's, and `completed_on`
    moves when a re-read finishes. A stopped re-read is kept, as a stopped read with the page
    it reached — the history is the point, and Delete removes one made by mistake — and the
    book stays Completed. A finished book takes no page until "Read again" opens a read
    (amending #34), so a page typed on the wrong book can't start anything. **Chosen without
    asking, overrulable:** with progress on share pages switched on, a re-read's progress shows
    like a first read's — the setting means "what I'm reading now". The edit form's status and
    dates edit the read that decides status, and it refuses what a read can't be — dates on a
    book not started, a completion date in progress, "Not started" for a book with reads —
    rather than guess. Share pages gain `readCount` from two finishes on ("Read N times"),
    always on, through `toPublicItem`; the reads and their dates stay private. Connections get
    `readCount` on every item — on a progress entry, the finished reads before the one its page
    belongs to, so a receiver can tell a re-read's pages from a first read's — and the Feed says
    "re-reading" and "finished again"; older versions ignore the field. No trigger changed: a
    finished re-read moves `completed_on`, and 0021's trigger already records a finish on that,
    dated by it (#40), inside an import too; starting or stopping a re-read changes neither
    column and records nothing. The export gains `reads` (`status:began..ended`, oldest first)
    and `read_count`; progress entries name their read (`#n`); a Nalanda re-import rebuilds the
    reads, and an older export still imports from its status and dates. Goodreads' Read Count,
    which the import had kept in details, becomes undated finished reads, capped at 100, and
    leaves details; a Goodreads merge adds reads and never removes one (amending #14), and a
    second run adds nothing, even after reading done here since the first — a read finished,
    stopped or started again here counts as the result a rule looks for. While a book is being
    read again, its edit form's status and dates are shown locked: they describe its last
    finish, and the re-read is managed on its page, so the form can't turn that finish into a
    stop or overwrite its date. On any finished book the form offers only Completed, and the
    route refuses In progress ("use Read again") and Abandoned: either would reopen or
    relabel the last finish, and "set it back to In progress" was the old way of saying
    "reading it again". Migration 0023 does the same for what is there already, inside
    the import marker so none of it is news: on production's data (backup of 2026-09-28,
    rehearsed through 0012 → 0023) it made 381 reads, left 20 of 22 tables identical, removed
    only `read_count` from 1,681 details, and changed 8 statuses — 6 books not started that
    Goodreads counted as read once became Completed, and 2 books in progress that had been
    finished before became Completed and re-reading, so they leave the in-progress connection
    view. Code from before 0023 writes status without reads, so a deploy of it goes out when
    nobody is editing and the Worker isn't rolled back past it (runbooks/deploy.md). Reads were
    household-level like status (§5); per-read ratings or reviews stay out of scope. *Amended
    by #43:* reads are each member's, the item's columns their household summary, and ratings
    and reviews per member. One consequence predates reads and stays: `completed_on` is the last finish, so
    deleting the latest finish, or adding a past finish newer than the current one, moves it, and
    0021's trigger announces a "finished" dated by the new date — dated honestly, but announced.

**2026-09-28 — versions and releases:**
42. **Nalanda is released as SemVer versions, starting at 1.0.0, with notes written for whoever
    hosts it.** Other households run their own copies, and a migration applies itself on deploy,
    so the one thing a self-hoster can't learn from the code is what an update will do to their
    data. So every release says so. A version lives in package.json and `src/version.ts` (kept in
    step by a test). CHANGELOG.md gives each release an **Upgrading** section: the migrations it
    runs and whether to back up, any new secret, and whether connected households on older
    versions are affected. Pushing a `vX.Y.Z` tag publishes that section as a GitHub Release
    (`.github/workflows/release.yml`, which holds no secret beyond its own token and never
    deploys). A patch fixes; a minor adds, including migrations that apply on their own; a
    major needs something from the host or breaks compatibility with connections. That last
    one is judged against the connections protocol, whose own version (in `/.well-known/nalanda`)
    is separate and changes only when instances stop understanding each other. The app's
    version shows on the Account page to signed-in people and is deliberately left out of the
    public descriptor: an instance shouldn't tell the world which release, and so which known
    bugs, it runs. v1.0.0 is the deploy of 2026-09-28 (cf2d7f2), tagged after the fact. GitHub
    runs a tag's workflow as it is in the tagged commit, and that one predates the workflow, so
    v1.0.0's release was published by hand; every later tag is on a commit that carries it, and
    the workflow refuses a tag that isn't on main. runbooks/updating.md is the self-hoster's path.

**2026-09-28 — each member's reading:**
43. **Reads and reviews are each member's; the item keeps the household's summary.** A household
    shared one status, one rating and one review per book, so two people reading the same book
    overwrote each other, and nobody could say who had read what. `reads` gains `reader_id`, and
    ratings and reviews move to a `reviews` table, one per member per item. **The owner chose to
    keep one household value wherever a book is filtered or published**, derived from everyone's
    rows, so every shelf, status filter, share link, connection view, activity trigger and export
    column goes on reading the item's own columns:
    - **status** is Completed if anyone has a finished read, else In progress if anyone has an open
      one, else Abandoned if there are only stopped reads, else Not started — the same ordering #41
      used, now over everyone's reads, so `READ_STATE_SET` is unchanged but for progress;
      `completed_on` is the latest finish by anyone, `read_count` everyone's finishes, and
      `rereading` an open read, by anyone, of a book finished before, by anyone — so a member's
      first read of a book someone else finished shows as re-reading, and nothing moves between
      views while it's read;
    - **progress_page** is the latest page recorded in any open read (with none open, the deciding
      read's last page, as before) — what "progress on share pages" shows;
    - **rating** is the average of everyone's ratings, rounded to the 1–10 scale, and **review** the
      one written most recently, by `reviews.reviewed_at`, with no author. `refreshReviewState()`
      rides in the batch of every review write (#39), as `refreshReadState()` does for reads, and
      writes an item only when its summary changed (an `UPDATE … FROM`), stamping `updated_at` then:
      connections see that time, and an average that didn't move is no change to the book. So a
      second member's rating that moves the average is a "rated" entry, dated now (#40), one that
      doesn't move it records nothing, and inside an import's marker it is dated by the book's
      last finish or left out, as before. `summarizeReviews()` is its TypeScript twin, held to it
      by a test.

    For a household of one every rule reduces to v1.2.1's, and the existing suite — run as one
    member owning what it seeds — passes unchanged in substance. **Inside the app** each person's
    reading shows on the book's page under their name, and everyone's rating and review with their
    username — but only once the household has more than one member, or someone other than the
    viewer has read or reviewed the book: a household of one sees the page, the edit form and the
    shelf exactly as before. "Read again", Finish, Stop and Record act on the signed-in person's own
    reads, so another member can start their first read of a book someone finished; the edit form's
    status, dates, rating and review are the editor's own, and its re-read lock and "use Read again"
    refusals are per person. A record's or game's "Not started" clears only the editor's reads.

    **Permissions.** Members change their own reads, pages and review; admins anyone's. Every route
    checks and answers 403 with a reason, and every statement that writes checks again (`Actor`,
    `allowed()` in queries.ts), so a check and its write can't come apart and a hand-made request
    changes nothing. Pages belong to their read's reader. **Admins can move** a read — with its pages
    — or a review to another member, to fix misattributed history; a move is refused onto someone
    already reading the book (their one open read) or who already has a review of it (one each, and
    merging two reviews is a person's call). **The "Read by" filter** narrows a shelf or a search to
    what someone finished (me, not me, a member by name, anyone) or is reading now. It is
    deliberately not part of `ItemFilters`, the type share links and connection views capture, so
    `shareFilters()`, `itemMatchesShare()` and the connection-view filters have no room for it and
    stayed untouched; the publish form carries no field for it, and the shelf says a link made from
    a filtered view shows it without "Read by". It is offered once there is more than one member.

    **Existing data goes to the first admin** (the lowest-id admin), the owner's call: migration
    0024 (generated) adds the column, replaces the open-read index with one per (item, reader) and
    makes `reviews`; 0025 (hand-written) credits every read and every page to that admin and makes
    one review per item with a rating or review, holding exactly what the item holds, dated by the
    item's `updated_at` — the last the review could have been written. The items themselves aren't
    touched and no trigger fires. Rehearsed on production's backup of 2026-09-28 (0000–0023, the
    per-table restore, then 0024–0025): all 27 pre-existing tables identical in every pre-existing
    column; 381 of 381 reads and the one page to the admin; 359 reviews (153 rating only, 20 review
    only, 186 both), each matching its item; statuses 376 / 2 / 1,620 with 2 re-reading, as before;
    and recomputing both summaries over all 1,998 items with the new SQL changed nothing in any of
    the 28 tables. Other self-hosters' history is credited to their first admin too, which the
    changelog says, with how to move it. **Removing a member** keeps their reads, pages and reviews,
    unattributed ("Former member"); `deleteUser()` clears `reads.reader_id` itself, since drizzle-kit
    drops ON DELETE on ALTER TABLE and D1 enforces foreign keys (a test fails with "FOREIGN KEY
    constraint failed" without it). The household's summary doesn't change.

    **Export and import.** The `reads` cell's tokens gain `@reader` (the username, percent-encoded so
    no name can break the cell; an empty name is a former member; no `@` is an export from before
    readers). A new `reviews` column holds everyone's reviews as JSON, with their writers and written
    times; `rating` and `review` stay beside it as the household summary for anything that reads only
    those. On import a name that is a member here keeps them; any other name, and anything that names
    nobody — an older export, a libib or Goodreads row — is the importer's, and the preview lists
    each name, what it brings and whose it becomes. Two names landing on one person keep one open
    read and the review written last. A Goodreads file is its importer's: it is reconciled with their
    reads alone and merges into their review, so it never touches anyone else's.

    **Chosen without asking, overrulable:** `reviews.reviewed_at` beside the recommended columns —
    without it, re-rating a book would make an old review the household's latest and announce it as
    new; the migration's review times come from `items.updated_at`; migration 0025 also re-credits a
    page another member recorded, so a read and its pages agree; the book page names people only in
    a household of more than one; progress among open reads is the latest page by anyone; a page
    recorded before reads (none on production) joins its recorder's first read; the per-read cap of
    100 is per reader; the Read by default is "Read by…" (no filter), with "anyone" meaning someone
    finished it; records and games keep their reading in the edit form, per person, with no per-person
    display. NULL readers are one "nobody" to the app's checks (`IS`), though SQLite's unique index
    treats NULLs as distinct and so doesn't hold unattributed open reads to one; nothing in the app
    opens one.

The honest comparison, since it was asked:

- **What this app is**: ~a dozen CRUD pages (lists, forms, a detail view) plus exactly one
  genuinely rich client feature — the camera barcode scanner, which is plain browser JS
  (camera + WASM decoder) under *any* framework. There's no SEO need (it's private), no
  real-time collaboration, no complex client state. That's the profile htmx handles with
  the least total machinery.
- **You still write JSX/TSX either way.** `hono/jsx` gives typed components — the DX
  difference vs React is where they render (server string vs client runtime), not how they
  look in the editor.
- **Vite + React SPA + Hono API** doubles the surface: every feature becomes an API
  endpoint *plus* client fetch/state/render code, plus client-side auth handling, plus a
  second build artifact to deploy. Reasonable price for an interaction-heavy app; pure
  overhead for this one.
- **Next.js on Workers** runs through an adapter (`@opennextjs/cloudflare`) — a heavy
  framework plus a compatibility layer, in exchange for RSC/ISR/image-optimization
  features this app wouldn't use. (Next on Vercel's free tier is the more natural Next
  path, but then data/storage needs a second provider — CF's D1+R2 free tiers are the best
  $0 fit, so compute stays where the data is.)
- **CPU budget**: SSR-to-string on every request is a few ms of template work — fine at
  10 ms. A React SPA would also be fine (static assets are free); this isn't the deciding
  factor, simplicity is.
- **When we'd switch**: if the app grows real-time features, offline/PWA ambitions, or
  heavy in-page interactivity (drag-drop shelf curation, say) — or if you simply decide you
  want to write React. The swap is contained: Hono stays as the API layer, routes already
  speak JSON where it matters, and the SPA mounts in front. Nothing in the data model or
  provider layer would change.
