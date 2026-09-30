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
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  display_name  TEXT,                   -- optional, what outsiders see when names are on (§16 #45); never a login
  session_key   TEXT NOT NULL DEFAULT '' -- 128 random bits, set at creation, never changed; a session names it with
                                        -- the id, which SQLite reuses (§16 #56). '' only for ALTER TABLE
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
  location     TEXT,            -- where it lives, free text ("study, 2nd shelf") — private like notes (§16 #51)
  copies       INTEGER NOT NULL DEFAULT 1,
  began_on     TEXT,            -- status, began_on, completed_on, read_count, rereading and
  completed_on TEXT,            -- progress_page are derived from `reads` (§16 #41)
  read_count   INTEGER NOT NULL DEFAULT 0,  -- finished reads
  rereading    INTEGER NOT NULL DEFAULT 0,  -- finished before, and read again now
  details      TEXT NOT NULL DEFAULT '{}',  -- JSON: type-specific + unmapped import fields
  media_condition  TEXT,        -- a record's grades, Goldmine codes M…P (§16 #55): this copy's,
  sleeve_condition TEXT,        -- private like copies — never on share pages or to connections
  added_by     INTEGER REFERENCES users(id),
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  series_id    INTEGER REFERENCES series(id),  -- its series (§16 #52); no ON DELETE: pruned once empty
  series_number REAL             -- 3, or 2.5 between two; NULL = in the series, number not known
);
CREATE INDEX idx_items_library ON items(library_id);
CREATE INDEX idx_items_isbn13  ON items(isbn13);
CREATE INDEX idx_items_series  ON items(series_id);

CREATE TABLE series (            -- a series items belong to, any media type (§16 #52)
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,        -- as first written
  key        TEXT NOT NULL UNIQUE, -- the name folded: Unicode lowercase, spaces collapsed — unique by this
  total      INTEGER,              -- how many numbered volumes it has; NULL = not known
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  reviewed_at TEXT,             -- when the text was last written: whose review the household shows
  rated_at    TEXT              -- when the rating was last given: what a "rated" entry is dated by
);
CREATE UNIQUE INDEX reviews_item_user ON reviews(item_id, user_id);

CREATE TABLE plays (             -- each time the household played a game or a record (§16 #54)
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  played_on  TEXT NOT NULL,     -- YYYY-MM-DD: a day, nothing more — no players, scores or durations
  logged_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- who pressed Played: for auditing and removal only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_plays_item_played ON plays(item_id, played_on);   -- an item's count, last and recent plays
CREATE INDEX idx_plays_played_item ON plays(played_on, item_id);   -- plays in a date range, by item

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
  title, creators, description, notes, location,   -- location since 0029 (§16 #51)
  content='items', content_rowid='id'
);
```

**`details` JSON — conventional keys per media type** (extended freely; unmapped import
columns also land here so imports are lossless):

- `book`: `{ subtitle }` — a series is no longer a details key but its own table and columns (§16 #52); a
  `series` key an older import left in details stays there, as text
- any type: `{ reviewed_in: [url, …] }` — blog posts covering this item; owned by the
  dedicated "Reviewed in" form field, rendered as outbound links on item and share
  pages (a deliberate lightweight alternative to a posts table — the blog side holds
  the post→books direction).
- `boardgame`: `{ bgg_id, players_min, players_max, playtime_min, playtime_max, year }`
- `vinyl` (and `music`): `{ discogs_id, label, catno, country, year, format, genres,
  tracklist }` — the pressing, from Discogs (§16 #55). `label` and `catno` hold every label
  and catalogue number, joined; `format` is one line (`2×Vinyl, LP, Album, 180 Gram, Red
  Translucent`); `tracklist` is `[{ position, title, duration, artist } | { heading }]`.
  Format/pressing and catalog number are what collectors actually care about. A record's
  **condition** is not here: `details` is public on share pages, and a grade describes this
  household's copy, so it has its own two columns.

Reading and reviews are **per member** since 1.3.0 (§16 #43); they were one shared household
opinion in v1. Reading state lives in `reads`, one row per time someone read the item, and
ratings and reviews in `reviews`, one per member. `items.status`, `rating` and their
neighbours are the **household's summary** of them — Completed once anyone has finished it,
the average rating, the review written last — recomputed in the same batch as every write
(§16 #41, #43), so shelves, filters, share pages, connections and the export read one value
per item as they always have.

Board games and records also have a **play log** (§16 #54): `plays`, one row per time the
household played one, dated by the day. It is the household's, not anyone's, and nothing on
`items` summarizes it — no status, date or count depends on a play.

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
(Discogs search) when there's no scannable barcode. Saving a Discogs result fetches its
release once — search results carry no tracklist — and a scanned record keeps its barcode
(§16 #55).

**Refresh from Discogs**: a record's page fills its pressing details from Discogs — one
request per click, by the stored release id or else the barcode, filling blanks only
(§16 #55).

**Manual add/edit**: plain form, all media types, works from day one.

**Reading again**: a finished book's page offers "Read again", which opens a new read; the
book stays Completed, marked re-reading, until Finish or "Stop re-reading" closes it. Every
read is listed on the book's page, correctable and deletable (§16 #41). Each is its reader's:
the buttons act on the signed-in person's own reads, another member can start their first read
of a book someone else finished, and everyone's reading shows under their name (§16 #43).

**Lending**: from an item page, "lend" captures borrower + optional due date; dashboard and
`/loans` show what's out and overdue; "returned" stamps `returned_on`. History is kept: `/loans`
lists recent returns, and an item's page lists its own under "Lent before" — each borrower, the
span and its length in days, newest first, the latest 20 with older ones counted (one query,
`pastLoansForItem()`). A loan to a connected household is an ordinary loan linked by
`connection_loans` (§16 #29), so its return is kept the same way and it shows as "household
(their member)" while that link lasts; removing the connection drops the link, and the loan keeps
the borrower it was lent under. In-app only, like every loan (§9). Every loan, open and returned,
leaves in the export's `loans` cell and a Nalanda import restores it — a connection's as a local
loan (§16 #57).

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
tag, and the series, §16 #52). Goodreads rows **match-and-merge** (§16 #14): a row matching an existing item — by
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
reader included (`reads`, `read_count`), every member's review (`reviews`) beside the
household's `rating` and `review`, and every loan (`loans`: borrower, dates, contact, note —
§16 #57). The columns, in order: `library`, `media_type`, `title`, `creators`, `isbn13`,
`isbn10_upc`, `publisher`, `published`, `description`, `length`, `progress_page`, `status`,
`rating`, `review`, `reviews`, `notes`, `tags`, `copies`, `loans`, `began_on`, `completed_on`,
`read_count`, `reads`, `added_at`, `progress_history`, `details` (`EXPORT_COLUMNS` in
`src/lib/csv.ts`). The Export button
fetches it a page at a time and joins the pages in the browser, so no request builds more than
250 items or 1,000 loans (§16 #38, #57); without a cursor the same route streams everything in
one response.

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
| BoardGameGeek XML API2 | board games | **`BGG_TOKEN`** (free, approved non-commercial app) | ✗ | XML (hence `fast-xml-parser`); name search + `thing` detail; `Authorization: Bearer` since BGG went registration-only in 2025 — 401 without it; throttles with 500/503 (429 at its edge, 202 = queued), which search reports as "busy"; its terms require the "Powered by BGG" logo (§16 #44) |
| Discogs | vinyl (all music) | free personal token | **✓ (UPC/EAN)** | 60 req/min with token; search returns format, label, catno, country, year; the release (`/releases/{id}`) adds the tracklist (§16 #55) |

- **Series** (§16 #52): Open Library's search index carries `series_name` and `series_position` for many
  works, which fill a candidate's series; Google Books never names one (its rare `seriesInfo` holds a number
  and an id, and `series/get` refuses API keys), so it contributes nothing there.
- Providers are called only at add/import time, or when someone asks — "Refresh from
  Discogs", one request per click (§16 #55) — zero runtime dependency on them for
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
  else (full item/library/loan CRUD, and bulk edit but for bulk delete, which is an admin's —
  §16 #47). Two roles, no permission matrix. Reading and reviews
  are each member's own (§16 #43): a member changes only their own reads, pages and review,
  an admin anyone's, and only an admin moves one to another member. Each member may set a
  **display name** — the only name that ever leaves the app, and only where an admin has
  switched names on (§16 #45); the username is the login and stays inside.
- Items record `added_by`, so "who added this" is visible on the detail page.
- Password hashing: **PBKDF2-SHA256 (100k iterations) via WebCrypto** — native-speed, fits
  the free plan's CPU budget. Never bcrypt/argon2 npm packages (pure-JS, would blow it).
- Session: HMAC-signed cookie, `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day expiry, naming
  the account's id **and its session key** — 128 random bits set when the account is made
  (§16 #56). Per request the middleware reads the user row, as it always did, and requires
  its key to match → deleting a user is instant revocation, and since SQLite reuses the id of
  the newest removed row, the key is what keeps a removed member's cookie from signing in as
  the next account made. The key never changes, so it is the account's identity across time:
  a cookie with no key — every one signed before migration 0029 — signs nobody in, and
  anything else derived from who someone is and kept across time (an HMAC stamp, say) binds
  `accountIdentity()` — id and key — never the id alone. Without a `SESSION_SECRET` (missing, empty or whitespace) nobody can
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
  finished it, only from twice on ("Read N times"), never the reads or their dates (§16 #41),
  and, on a shared board game's or record's own page, `playCount` — how many times the
  household played it, from the first play on ("Played N times"), never a play's date or who
  logged it (§16 #54). Listing cards don't carry it. And, on a shared item's page, its series name and number,
  public catalogue data like the publisher (§16 #52; never the numbers missing from it or
  anyone's "next up", and not on listings or to connections).
  The rating is the household's average and the review the one written last, with no author
  (§16 #43). **Never**: private notes, where an item lives (`location`, §16 #51), loans/borrowers,
  the copies count, added_by, usernames, the dates of anyone's reads or plays, or any nav into the
  authenticated app — and nothing per member
  unless an admin switches names on (below). The whitelist lives in one view module so it
  can't drift.
- **A record's pressing is public; its condition is not** (§16 #55). "Media details" includes
  a record's pressing — label, catalogue number, country, year, format — and its tracklist,
  all in `details`: catalogue data anyone can look up on Discogs. The media and sleeve grades
  describe this household's copy, like the copies count, and live in their own columns, which
  no whitelist carries.
- **Names are the household's choice, off by default** (§16 #45). `site_settings.names_on_shares`
  (admin-only, on **Shared links**) adds one field to a shared book's page: `reviews`, each
  member's rating and review signed with their **display name** — or "A member", for a member
  without one — beside the household's average. Nothing else changes: reading history stays
  "Read N times", never whose or when; listing cards keep the average; a login username never
  appears. Off, the key is absent and the page is byte for byte what it was.
  Not item data, and so outside the whitelist: a page that shows a board game carries
  BoardGameGeek's "Powered by BGG" logo in its footer, linked to boardgamegeek.com with
  `rel="noreferrer"` (§16 #44).
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
GET  /account                  change own password (also the forced first-login flow) · POST /account/display-name

GET  /                         dashboard: libraries, recent adds, loans out, "Read next"
                               (?not=<id> with HX-Request → the "Read next" card alone; §16 #46)
                               (anonymous + HOME_SHARE_TOKEN set → 302 /share/<token>)
GET  /libraries/:id            item grid/list; filter/sort/paging via htmx partials
                               (?readBy= — "Read by", never publishable; §16 #43)
GET  /items/:id                detail  ·  GET /items/:id/edit
POST /items                    create (htmx: answers with the added entry; a held scan's
                               scanOwner must be the signed-in account's, §16 #48)
                               ·  POST /items/:id (update) · POST /items/:id/delete
POST /bulk                     bulk edit: action=tag-add | tag-remove | move | owned | not-owned |
                               delete (admins; confirm=1 after a confirmation page) over repeated
                               id=, at most 250 — one batch each (§16 #47)
POST /items/:id/progress       record a page · POST /items/:id/progress/:entry/delete
POST /items/:id/reads/start    open a read ("Read again") · POST /items/:id/reads (a past read)
POST /items/:id/reads/:read    correct · …/finish · …/stop · …/delete   (books; §16 #41)
                               · …/move (admins: to another member, with its pages; §16 #43)
POST /items/:id/reviews/:rev   edit · …/delete · …/move (admins)   — own review, or any for an admin
POST /items/:id/plays          "Played": a play today or on the date given (games, records; §16 #54)
GET  /items/:id/plays          every play, 100 a page · POST /items/:id/plays/:play/delete (its
                               logger, or an admin; ?back=plays returns to that page)
GET  /add                      add flow: scan | search | manual
GET  /add/review               ?barcode=…&scanned=… — one scan held offline, looked up (partial; §16 #48)
GET  /api/lookup               ?barcode=… | ?q=…&type=boardgame → JSON candidates
POST /items/:id/loan           lend    ·  POST /loans/:id/return
GET  /loans                    out + overdue + history
GET  /search                   ?q= — FTS5 across title/creators/description/notes
GET  /tags · GET /tags/:id     browse by tag
GET  /series · GET /series/:id  series: volumes in order, missing numbers, the viewer's next up (§16 #52)
POST /series/:id                rename (a taken name merges) and set its total
GET  /import                   POST /api/import (JSON batches from client-parsed CSV)
GET  /export.csv               everything; ?library=:id to scope; ?after=:id for one page of 250
                               items or 1,000 loans (x-export-next names the next page) — the
                               Export button's way
GET  /covers/:key              cover art from R2 (public, unguessable, immutable cache)

GET  /settings/users           admin: create/remove members, reissue temp passwords
POST /shares                   admin: publish a view (captures shelf + filters + name)
POST /shares/:id               admin: action=rotate | delete
POST /shares/settings          admin: setting=progress | names (the share-page switches, §16 #34, #45)
POST /settings/users/:id/display-name   admin: set a member's display name (§16 #45)

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
                                views · follow · purge · unfollow · progress-sharing · names-sharing
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
│                                     # whitelist), csv.ts, covers.ts, reads.ts, reviews.ts,
│                                     # plays.ts
├── public/                           # app.css, app.js, scanner.js, import.js, covers.js;
│                                     # manifest, icons/, sw.js, offline.html, scan-queue.js,
│                                     # scan-review.js (the installed app, §16 #48);
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
CSV export is fetched a page at a time and joined in the browser (§16 #38), a page ending
early once it holds 1,000 loans, as an import batch does (§16 #57);
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
~~per-member ratings/status~~ (done in 1.3.0, §16 #43) · stats page · ~~bulk edit~~ (§16 #47) · TMDB/IGDB providers if movies/video
games ever matter · Cloudflare Access as an optional extra gate · custom domain hookup.

**Non-goals:** multi-tenant SaaS, native mobile apps, offline sync (holding scans for review is not sync — §16 #48), public social features
or fediverse interop, ebook file hosting (calibre-web's territory), background jobs of any
kind. (Pairwise connections between two self-hosted instances are in scope — §16 #29.)

## 15. Risks

1. **Vendor lock-in (Cloudflare)** — mitigated by §13; accepted in exchange for $0/mo.
2. **10 ms CPU** — designed around (§12); $5/mo escape hatch exists and needs no rewrite.
3. **Metadata gaps** — Open Library coverage is imperfect (Google Books fallback);
   BGG has no barcode lookup (board games are name-search by design); Discogs needs a free
   token and throttles at 60/min (irrelevant at add-time volumes). Manual edit always works.
4. **BGG API quirks** — XML, occasional throttling/queueing; search says BGG is busy
   rather than reporting no games, and the laptop backfill paces BGG at one request every
   5 seconds, as BGG's docs advise.
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
      last finish or left out, as before. A review or rating taken away isn't news: the trigger
      sees only that the item's review changed, so when a member's newer review goes and an older
      one shows again, the same batch dates the replacement entry by when the review now shown was
      written (`reviewed_at`), and a rating entry by when the latest remaining rating was given
      (`rated_at`, which only a change of the rating's value moves — dating it by `updated_at`
      re-announced a 2019 rating as news after its review's text was edited, found by nalanda-review)
      — never later than the trigger dated it, so something just written keeps its time
      (`redateReviewActivity()`; found by the adversarial pass, which saw a 2019 review re-announced
      as today's). `summarizeReviews()` is
      the refresh's TypeScript twin, held to it by a test.

    For a household of one every rule reduces to v1.2.1's, and the existing suite — run as one
    member owning what it seeds — passes unchanged in substance. **Inside the app** each person's
    reading shows on the book's page under their name, and everyone's rating and review with their
    username — but only once the household has more than one member, or someone other than the
    viewer has read or reviewed the book: a household of one sees the page, the edit form and the
    shelf exactly as before. "Read again", Finish, Stop and Record act on the signed-in person's own
    reads, so another member can start their first read of a book someone finished; the edit form's
    status, dates, rating and review are the editor's own, and its re-read lock and "use Read again"
    refusals are per person. A record's or game's "Not started" clears only the editor's reads, so
    its page lists everyone's reads by name too (once there is more than one member), where the
    reader or an admin corrects, finishes, stops or deletes one and an admin moves it; starting a
    read and pages stay a book's. On a book's page too an admin gets Finish and Stop on anyone's
    open read, which the routes always allowed.

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
    one review per item with a rating or review, holding exactly what the item holds, its text and
    its rating dated by the item's `updated_at` — the last either could have been given. The items themselves aren't
    touched and no trigger fires. Rehearsed on production's backup of 2026-09-28 (0000–0023, the
    per-table restore, then 0024–0025): all 27 pre-existing tables identical in every pre-existing
    column; 381 of 381 reads and the one page to the admin; 359 reviews (153 rating only, 20 review
    only, 186 both), each matching its item, with `rated_at` set on all 339 rated ones and no other;
    statuses 376 / 2 / 1,620 with 2 re-reading, as before; and recomputing both summaries over all
    1,998 items with the new SQL changed nothing in any of the 28 tables. (Re-rehearsed on
    2026-09-29 after `rated_at` joined 0024 — regenerated, since neither migration had reached a
    persistent database — with the same numbers.) Other self-hosters' history is credited to their first admin too, which the
    changelog says, with how to move it. **Removing a member** keeps their reads, pages and reviews,
    unattributed ("Former member"); `deleteUser()` clears `reads.reader_id` itself, since drizzle-kit
    drops ON DELETE on ALTER TABLE and D1 enforces foreign keys (a test fails with "FOREIGN KEY
    constraint failed" without it). The household's summary doesn't change.

    **Export and import.** The `reads` cell's tokens gain `@reader` (the username, percent-encoded so
    no name can break the cell; an empty name is a former member; no `@` is an export from before
    readers). A new `reviews` column holds everyone's reviews as JSON, with their writers and when
    each text was written and rating given (`at`, `ratedAt`; a cell without `ratedAt` takes `at`,
    else the import's time). As in the reads cell, an entry with no `by` is the importer's and an
    explicit null or empty one a former member's; `rating` and `review` stay beside it as the household summary for anything that reads only
    those. On import a name that is a member here keeps them — but only in an admin's import: a
    member changes only their own reading, so a member's import is all theirs, or it would let them
    write in someone else's name. Any other name, and anything that names nobody — an older export,
    a libib or Goodreads row — is the importer's, and the preview lists each name, what it brings
    and whose it becomes. Two names landing on one person keep one open read and the review written
    last; several former members keep an open read each, as the database holds them. Reads are
    capped at 100 per reader, as the app caps them, and 1,000 a row. A 1.3 export doesn't import
    correctly into an older version, whose parser reads `2020-01-01@asha` as no date; the changelog
    says so. A Goodreads file is its importer's: it is reconciled with their
    reads alone and merges into their review, so it never touches anyone else's.

    **Chosen without asking, overrulable:** `reviews.reviewed_at` and `rated_at` beside the
    recommended columns — without the first, re-rating a book would make an old review the
    household's latest and announce it as new; without the second, rewording a review would make its
    old rating news when another's goes; the migration's review times come from `items.updated_at`; migration 0025 also re-credits a
    page another member recorded, so a read and its pages agree; the book page names people only in
    a household of more than one; progress among open reads is the latest page by anyone; a page
    recorded before reads (none on production) joins its recorder's first read; the per-read cap of
    100 is per reader; the Read by default is "Read by…" (no filter), with "anyone" meaning someone
    finished it; removing a review or rating is not news. NULL readers are one "nobody" to the app's checks (`IS`), though SQLite's unique index
    treats NULLs as distinct and so doesn't hold unattributed open reads to one; nothing in the app
    opens one.

    *Amended by #45:* members' names can reach share pages and connections as display names —
    never usernames — when an admin switches them on; off, as above.

**2026-09-29 — BoardGameGeek's terms:**
44. **BoardGameGeek's "Powered by BGG" logo sits beside its data.** BGG approved this app's
    use of its XML API as a non-commercial, public-facing application, and its terms make the
    logo a condition: "public facing apps must include the 'Powered by BGG' logo, which should
    link back to BoardGameGeek", sized "so that the text remains easily legible"
    (boardgamegeek.com/using_the_xml_api, wiki/page/XML_API_Terms_of_Use). It appears where
    BGG's data does, not on every page: under BGG results in the Add page's search, on a board
    game's page, and in the footer of a share page that shows a board game — the share list
    when any game on that page of it is one, a shared item when it is. The rule is the media
    type, not whether a game's fields came from BGG this time: every board game Nalanda fills
    in is filled from BGG, and a rule that inspects the data would need provenance the schema
    doesn't keep. On share pages the logo is an attribution, not item data, so it stays
    outside `toPublicItem()` (§9): it reveals only that a board game is on the page, which the
    page already says, and its link leaves with `rel="noreferrer"` so a share's token never
    travels to BGG. BGG's own SVGs are committed unmodified in `public/bgg/` — the colour file
    for the light theme and the reversed one, white lettering, for the lamp-lit dark theme,
    swapped by a `<picture>` on `prefers-color-scheme` — 32px tall, served as static assets
    before the Worker, and covered by `MISSING_ASSET` so a missing one is a plain 404, never a
    login redirect. They are BGG's trademark, not MIT (THIRD-PARTY.md). Not credited: a
    connected household's board games on Feed and shelves, which the peer fetched from BGG
    under its own terms, and the signed-in shelf tables, which a board game's own page covers.
    BGG forbids modifying its data, so a description is kept whole (the owner's call): the
    provider only decodes the character references BGG's XML leaves escaped (`&#039;`,
    `&mdash;`, line breaks) and drops spaces before a line break. It used to cut descriptions
    at 2,000 characters and collapse blank lines, losing paragraphs. One term stays with the
    owner: BGG may change its terms at any time (the Geek Tools News forum announces changes).

**2026-09-29 — names outside the app:**
45. **Members' names reach share pages and connections only as display names, only while an admin
    has switched them on — and with both switches off nothing outside changes.** #43 made reading
    and reviews each member's but kept the household anonymous outside. The owner asked for names,
    under the household's control, deciding each point in turn:
    - **The setting is the household's**, set by an admin: two switches beside
      `progress_on_shares`, both off by default — `names_on_shares` (on **Shared links**) and
      `names_to_connections` (on **Connections**). No per-member opt-in.
    - **What is shown is a display name**, new and optional, per member: set on their Account page,
      or by an admin under Members. Trimmed, single-spaced, stripped of control and format
      characters (so no bidi override can reorder the text around it) and of fillers that look like
      nothing — but for the zero-width joiner and non-joiner where they join two characters, which
      Persian words, Indic conjuncts and emoji families need — at most 40 characters, *not*
      unique — nothing needs to tell two Sams apart by it — and never a login. A member without one
      stays unnamed. A login username never leaves the app. It is a user field, not an item's, so it
      isn't in `/export.csv`; backups carry it with `users`.
    - **Share pages with names on** list each member's rating and review under their display name,
      labelled "A member" without one, as a connection's item page labels it, beside the
      household's average (§9). Reading history stays "Read N
      times", and no read's date appears.
    - **Connections with names on** get one feed entry per person — "Priya finished", "Ravi
      rated", "Priya reviewed", "Ravi started", and each page — so two people finishing a book make
      two entries, each with that member's own rating or review; an item page lists everyone's
      rating and review by display name. Names a connection sends render here as escaped text,
      stripped as ours are: a card per person on the Feed, their reviews on their item page.
    - **A login never leaves the app — comments and borrow requests included.** Before this, a
      comment or a borrow request carried its author's username (the connections proposal's
      decision 2, when there was no other name to carry). They now carry `outwardName()`: the
      member's display name while `names_to_connections` is on, else "A member". This household's
      own copy keeps the username, as everywhere inside the app.

    **Recording always, choosing at serve time.** Names are applied when a page renders or a
    connection pulls, never when something is recorded, so switching off hides names from every
    later render and pull, and a rename or a removed member (shown unnamed) takes effect at once.
    Per-person facts are recorded always, by triggers (migration 0027) on `reads`, `reviews` and
    `reading_progress`, into a new `member_activity` table — only while a connection view exists.
    A row points at its read, review or page, never at a person, so who did it is resolved at pull
    time, and `ON DELETE CASCADE` takes an entry with what it showed. The household's
    `activity_log`, its triggers and its ids are untouched — a test drops the new triggers and
    shows `activity_log` recorded identically, ids and all. Mixing per-person rows into
    `activity_log` was set aside: they would have shifted the household entries' ids, which peers
    hold as cursors, and so changed what is served with the switch off.

    **No read's dates, even by implication.** A household entry is dated by when it happened (#40),
    and a finish by its read's end — but per person, that date *is* the member's read date. So a
    start or a finish reaches `member_activity` only as it happens — a read begun or ended today or
    yesterday (the server's UTC day), or undated — and is dated now. A past read added later, or
    one an import brings, records nothing per person (the household's stream still records it, as
    ever), and neither 0027 nor a first view's backfill records starts or finishes: the backfill
    holds ratings and reviews, dated by their book's `completed_on` as the household's are, and
    pages by their own time. A rating or review is dated now, or inside an import by the book's
    `completed_on`, and not at all without one; a rating of 0 isn't one.

    **A rename or a move reaches what peers already hold.** Names are resolved at pull time, but a
    peer keeps the entries it pulled. So renaming a member — or removing one, who then shows
    unnamed — re-keys that member's entries in the same batch (`rekeyMemberActivity()`, §16 #39):
    the same entries, dated as before, under new ids. The removal check then withdraws the old
    copies and the next pull brings the renamed or unsigned ones. Saving the same name again
    changes nothing. An admin moving a read (with its pages) or a review to another member re-keys
    just that read's or review's entries (`rekeyMoved()`), straight after the move's UPDATE and
    guarded by its `changes()`, so a refused move re-keys nothing; both members' other entries
    still say who did them. A finish or a page per person counts that member's own reads
    (`readCount`, `readsBefore`), not the household's, so a first read isn't "finished again"
    because someone else read the book.

    **Two streams, one cursor space.** A connection pulls the household's stream with names off,
    exactly as before, and the per-person stream with names on; per-person ids are served offset
    by `MEMBER_ACTIVITY_BASE` (2^40), past any `activity_log` id and within a safe integer. A cursor
    from the other stream is "past the end" or "before the start", which the existing rule turns
    into the newest page — so a switch either way needs nothing from the peer. The removal check
    judges ids by range, and one stream is valid at a time: household entries only while names are
    off, named ones only while they're on. Switching either way withdraws what the other stream
    sent at each connection's next check, so nobody sees an event twice, once unsigned and once
    by name. A household is trusted to delete them; one can keep what it already pulled, and the
    Connections page says so. Deleting a shelf that takes the last connection view with it clears
    both logs, as removing the last view does. On our Feed, a book several people reviewed shows
    its one comment thread under the first of their cards.

    **The protocol stays version 1** — additive, optional fields only. A feed item may carry `by`
    (a display name), and an item page `reviews` (`{ by, rating, review }`, `by` null for an
    unnamed member); with names off neither key is present, so every served byte is as before —
    tests compare the feed, item pages and share pages with and without display names and the
    per-person log. An older version's parser ignores both fields (a copy of it, in
    `test/fixtures/`, reads what this version serves) and skips entries of the new kind
    `started`, keeping the page, as #35 arranged for unknown kinds. Such a household shows the
    per-person entries as the household's, unsigned — two people's finishes of one book merge into
    its one card, since it groups by book and kind. D1: with names on and nine members, tests hold a
    share item page to 6 calls and a feed pull to 10 (budget 50, §16 #37); a rename is one batch.

    **Chosen without asking, overrulable:** display names are not unique and not in the CSV export;
    an unnamed member's entries still come one per person, just unsigned; "as it happens" means
    today or yesterday, UTC, so a finish marked just after midnight still counts; a comment or a
    borrow request is signed "A member" while names are off, though decision 2 had it carry a
    name — the switch's label says names don't go out; a rating or review in the per-person
    backfill is dated by its book's `completed_on`, as the household's is, since #40 learned that
    imports rewrite everything else; names a connection
    sends are cut to 40 characters here and a name over 80 rejects its entry; our Feed puts the
    name before the verb ("Priya finished") and drops a "started" once pages or a finish follow it.

**2026-09-30 — what to read next:**
46. **"Read next" suggests from the signed-in member's own reads, at random, in one query.** The
    owner asked for a card on the Overview that picks a book to read, "nothing too complex", and
    decided its rules:
    - **Books only**, and **any book** in the catalog, owned or not; a pick with `copies = 0`
      carries the usual "Not owned" pill.
    - **The pool is personal**: a book the member hasn't finished (no completed read of theirs) and
      isn't reading now (no open read of theirs). Other members' reads don't count, so the
      household's `items.status` (#43) is never consulted — a book someone else finished is still
      the member's to read. A read they stopped leaves the book in the pool.
    - **Two buttons, no filters.** "Start reading" posts to the book page's own
      `POST /items/:id/reads/start` without htmx, which opens the member's read and redirects to
      the book, so reading starts one way everywhere. "Another" draws again and never shows the
      book just shown while any other qualifies.

    **Random in SQL.** `pickNextRead()` filters `items` to books with a `NOT EXISTS` on `reads`
    (the `idx_reads_item` lookup) and orders by `id = <just shown>, random()` with `LIMIT 1`: the
    book just shown sorts last, so it comes back only when it is the whole pool, and under
    `LIMIT 1` SQLite's sorter holds one row rather than the whole pool. Measured on about 2,000 items (1,800 books, 1,333
    reads): one D1 call reading about 5,000 rows — the same order as the Overview's per-type
    counts, which scan the catalog already — and about a millisecond locally. A `NOT IN` over the
    member's reads read more rows (it scans every read), so it stayed correlated.

    **One handler, two renders.** "Another" is a GET form for `/?not=<id>`: htmx asks with
    `HX-Request` and the Overview's handler answers with the card alone — the session's user and
    the pick, 2 D1 calls — swapped into `#read-next`, which is an `aria-live` region; the new
    "Another" keeps its id, so htmx gives it focus back. Without htmx the same URL is the whole
    Overview with a new pick. The response says `Vary: HX-Request`, since one URL answers both
    ways. The full Overview goes from 9 D1 calls to 10, whatever the catalog's size (budget 50,
    #37); tests hold both counts. This holds only while nothing else sends htmx to `/`: htmx 2
    restores history with `HX-Request` set when its cache misses (`historyRestoreAsHxRequest`),
    so if `hx-boost` or `hx-push-url` ever arrives, the card must move to its own partial URL
    (e.g. `/read-next`) rather than vary `/` on the header (noted by nalanda-review).

    **Chosen without asking, overrulable:** an empty pool shows a one-line "Nothing to suggest"
    in the card's place rather than dropping the card — a card that vanishes once you've read
    everything looks like a bug, and "Another" needs somewhere to land if the pool empties
    between clicks — but a catalog with no books at all leaves the card off, since there is
    nothing it could ever suggest and the Overview already says the shelves are empty; the card
    sits between the totals and the shelves; a stopped read doesn't take a book out of the pool
    (the owner's rule names finished and open reads only).

**2026-09-30 — bulk edit:**
47. **Bulk edit is one batch per action, and deleting in bulk is an admin's.** The owner asked for
    bulk edit and decided its shape:
    - **Selection**: a checkbox on each row of the shelf table, each card of the covers view and
      each search result, "select all on this page", and an action bar once anything is selected.
      Every media type.
    - **Actions**: add or remove a tag (normalized as every tag write is), move to a shelf, owned or
      not owned — copies 1 or 0, the Holding toggle's two moves, with items held in 2 or more
      copies skipped and counted in the result, for #27's reason — and delete.
    - **Delete is admin-only**, though any member can still delete one item from its page. A slip
      on "select all" takes sixty books with their reads, reviews and loans. Members never see the
      action, and `POST /bulk` refuses it to them with a 403 and a reason before reading anything,
      so a member never sees the titles it would have listed. An admin confirms first, on a page
      naming the count and the first ten titles, "and M more".

    **One route, one plain form.** `POST /bulk` takes `id` (repeated), `action`, `tag`,
    `libraryId` and `back`. The checkboxes live in the table and the grid, outside the bar's form,
    and join it through `form="bulk"`: the table is never inside a form, because htmx sends an
    enclosing form's fields with any request from inside it, and the Holding toggles post from
    there. Without JavaScript it all still submits. CSS `:has()` shows the bar once a box is
    checked, and shows the tag field or the shelf menu only for the actions that use them; a
    browser without `:has()` shows the whole bar all the time, and it still works. `app.js` adds the
    count, select all, Clear, and a tag field that's required when a tag action is chosen. The
    delete confirmation is a server page rather than `confirm()`: it works without JavaScript, and
    it can list the titles. The route redirects to the page it came from — a shelf or a search, and
    anything else goes home, so `back` can't be an open redirect — with the counts in the query. The
    notice is built from those numbers alone, so a link can't put words on the page.

    **One batch per action (#39).** Each action is one `d1.batch()`: a tally `SELECT` first, then
    the writes, with the ids as one JSON parameter read through `json_each`, as `refreshReadState`
    takes them. Adding a tag creates it, stamps the items it changes and links them in the same
    batch. A failure anywhere leaves every item as it was: tests make the last write fail with a
    trigger and find no tag created, no link, no timestamp moved, nothing moved or deleted, and no
    cover removed. **At most 250 items an action**, refused rather than cut short. A shelf page shows
    60 and a search 50, so the cap binds only a hand-rolled post, and it keeps one request to one
    small batch. D1: two calls an action (the session check and the batch), three for a move (the
    shelf check), at most six for the confirmation page, measured at the cap. The Worker only
    parses ids; SQL does the rest.

    **As if each were edited alone.** An item an action changes gets a new `updated_at`, and the FTS
    triggers re-index it on the same `UPDATE`. An item already as asked is left alone, `updated_at`
    included: it counts as "already" in the result. The edit form stamps every save, but a bulk
    action saying "3 already had it" shouldn't make those three look edited. No action touches
    reads or reviews, so no household summary moves. Delete is the single delete's `DELETE` over a
    list, with the same cascades (tags' links, reads, pages, reviews, loans, activity, comments) and
    the same `BEFORE DELETE` triggers of migration 0010, row by row. A test deletes two fully loaded
    books one at a time and two in bulk, compares every related table and the outbox, and finds the
    connection's Returned and BorrowDecline messages in one unbroken sequence. Covers go through
    `waitUntil` once the batch has succeeded, as the single delete's do.

    **Share links and connections.** Tags, shelf and copies are what share links and connection
    views select on, so a bulk action changes what they show. The middleware clears the share-page
    cache after it, as after any mutation (#19). Migration 0021's triggers watch `review`, `rating`,
    `status` and `completed_on` only, so a move, a tag or a holding change records no activity.
    Moved into a connection view, items bring their existing entries under their old ids, which
    are below every follower's cursor, so nobody's feed floods. A new follower's first page is by
    date and may include them, as for any item in the view. Moved out, their entries are withdrawn
    at the next removal check. Tests hold `activity_log` and `member_activity` to the same rows,
    ids and dates across a move. No migration.

    **Chosen without asking, overrulable:** a selection is one page's, and doesn't carry across
    pages; commas in the tag field make several tags, as on the edit form; removing a tag leaves the
    tag itself, as the edit form does; over the cap is refused, never truncated; the notice counts
    but doesn't name the tag; the route is `/bulk`, not `/items/bulk`, which `/items/:id` would
    shadow.

**2026-09-30 — an app on the phone, and scanning with no signal:**
48. **The installed app keeps no pages; offline scans are barcodes held on the device, for the
    account signed in there.** Nalanda installs to a home screen (manifest with id, scope, a Scan
    shortcut, paper as theme and background; 192/512 tiles with see-through corners, a full-bleed
    maskable 512 — the tiled master's tower at 0.8 scale, centred, inside the 40% safe zone — and
    the 180 apple-touch-icon; iOS home-screen metas). The owner's three decisions: installable;
    the scanner works with no signal, holding barcodes in IndexedDB until the Add page's review
    list, where each is added to a chosen shelf or dropped (or "add all to <shelf>"), and nothing is
    added unseen; and **no authenticated HTML or API answer is ever cached on the phone** (shared
    devices).

    *The service worker* (`public/sw.js`, served from the root as a static file, so its scope is
    `/`) keeps one versioned cache, `nalanda-static-v<VERSION>`, of the files in `STATIC`: the
    offline page, app.css, the favicon, the Eczar fonts, scan-queue.js, scanner.js and the ZXing
    reader with its wasm — nothing about anyone. Navigations go to the network and are never
    stored; only a failed one gets `/offline.html`. A listed file is network-first (refreshing
    its copy, used only when the network fails), so a deploy reaches phones at once and nobody is
    stranded on old assets; install fetches past the HTTP cache without credentials and refuses
    anything but a 200 that wasn't redirected; activation deletes every older `nalanda-` cache;
    `skipWaiting` + `clients.claim`, and app.js registers with `updateViaCache: 'none'`. Every
    other request — `/share/*` (never answered, even offline: its behaviour is unchanged), API
    calls, htmx partials, covers, other origins, every POST — gets no `respondWith` at all.
    Registered from app pages and the login page only; share pages never register it. Nothing
    but a failed navigation asks for the offline page, so a successful page load refreshes its
    copy (at most hourly, without a cookie) — otherwise an edit to it would wait for a version bump.

    *Why a static offline page rather than caching `/add`:* the Add page is a signed-in page
    (shelves, the sidebar's names), so keeping it would break the rule. `offline.html` is a
    static file with the scanner and nothing else; it stands in for any page the network can't
    reach. The Add page already open when the signal goes keeps scanning too: a barcode found
    while `navigator.onLine` is false, or whose lookup never reached the server (`htmx:sendError`
    on `/add/results`), is held instead. Offline, the camera stays on for the next barcode.

    *The queue* (`scan-queue.js`): IndexedDB `nalanda-scans`, one row per barcode —
    `{ barcode, scannedAt }` and nothing else — at most 200, a repeat kept once. The review list
    (`scan-review.js`) looks each one up through `GET /add/review?barcode=&scanned=` — the lookup
    behind `/api/lookup`, one barcode a request, two at a time, so each stays in one request's
    subrequest and CPU budget — which renders the entry server-side (`ReviewEntry`), testable in
    workerd, rather than building cards from `/api/lookup`'s JSON in the browser. Adding posts
    the entry's form to `POST /items` with `HX-Request`, which answers htmx with the added entry
    (one handler, two renders); a row leaves the queue only after that 200. Drop is the device's
    alone: it deletes the row, and no server route exists for it.

    *Whose queue:* the device's and the signed-in account's. Every signed-in page carries an
    opaque stamp, `scanQueueOwner()` = HMAC(`SESSION_SECRET`, `scan-queue:<id>:<session key>`),
    16 bytes — the account's identity, not its reusable id (#56); app.js
    keeps it in localStorage and, **when a different stamp appears, deletes the queue** before
    anything reads it (it runs first, and IndexedDB serves a delete before a later open). **Logout
    also deletes it** and forgets the stamp (bounded at 1.5 s so a stuck IndexedDB can't keep
    anyone signed in). Chosen over logout-only because a session can end without a logout (expiry,
    a cleared cookie) and the next person to sign in on a family phone would have seen the scans;
    the stamp covers that, and logout covers a device nobody signs back into. With no stamp —
    signed out — the offline page won't hold scans. scan-queue.js also compares the device's
    stamp with the page's own and refuses to list, hold or remove on a mismatch, so a page whose
    app.js failed to load still shows nothing of the previous account's. A review entry carries the stamp it was
    rendered for (`scanOwner`), and `POST /items` refuses it with 409 for anyone else — a list
    left open in one tab while someone else signs in in another adds nothing. The stamp says
    nothing about the account, and its message has a colon, which a session payload (base64url)
    never does, so no stamp is a valid session signature.

    *Headers:* `secureHeaders()` sets no CSP and no Permissions-Policy, so the worker, the manifest,
    the camera and IndexedDB need nothing; static files never pass through the Worker anyway.
    Signed-in pages keep sending no Cache-Control, as before. `wrangler.jsonc` sets
    `html_handling: "none"`: Cloudflare otherwise redirects `/offline.html` to `/offline`, which
    the worker can't store as a navigation answer, and a missing `/offline` would reach the login
    redirect; `MISSING_ASSET` now covers `.html`, so a missing one 404s.

    *Tests:* vitest binds `public/` as `ASSETS` (tests only) to read the manifest, icons and sw.js
    as served, and runs sw.js's own source against a stand-in `self`/`caches`/`fetch` —
    install, activate, and a table of requests. What needs a browser (registration, going
    offline, IndexedDB, the review list, logout) was checked with Playwright against a scratch
    dev server.

    **Chosen without asking, overrulable:** network-first for the listed files (no speed-up
    online, in exchange for never serving an old one while the network works); a 200-scan cap;
    re-rendering the 192/512 tiles, whose corners were white; a manifest shortcut to /add; the
    offline page refuses to hold scans when nobody is signed in on the device; "add all" skips
    entries with no match; `/offline.html` rather than `/offline`. The §14 non-goal "offline sync"
    stands: nothing is synced — the phone holds barcodes until a person reviews them.

**2026-09-30 — where it lives:**
51. **An item's location is one free-text column, private like notes, and searchable.** A household
    with books in three rooms and games in the loft wants to know where a thing is. The owner
    decided each point:
    - **Free text, optional, one per item** — `items.location`, "study, 2nd shelf" or "Loft · box 3",
      in the household's own words. Not a table of places, not per copy: two copies in two rooms
      are one line of text ("one in the study, one in the loft"). Set on the item form, adding (the
      manual form) and editing; shown as a Location row on the item's page when there is one. The
      form keeps it one line with spaces collapsed; blank is none.
    - **Search finds it.** It joins the FTS index as a fifth column, so global search matches it;
      a shelf's search box matches it beside title and creators (a `LIKE`, as those are). FTS5
      can't add a column, so migration 0032 — a custom one, after 0031 adds the column — drops
      `items_fts` and its three triggers, makes them again with `location` added and bodies
      otherwise unchanged, and refills the index with `'rebuild'`. The index is external-content
      (`content='items'`), so dropping it loses nothing. Rehearsed on the backup of 2026-09-29
      (1,998 items): every table's existing columns identical row for row, and 242 searches
      returning the same items in the same order.
    - **Never published.** It is not in `toPublicItem()` or `toConnectionItem()`, so share pages,
      a connection's shelf, item page and feed never carry it; tests serve each with and without
      a location and compare byte for byte, names switched off and on. The item activity triggers
      fire on `review`, `rating`, `status` and `completed_on` only, so changing a location is no
      news. A shelf's search box matches it, but share links and connection views never capture
      that box's text (`shareFilters()`, `shelfPage()`), so no published view can be filtered by
      where things are kept.
    - **Portable.** `/export.csv` has a `location` column after `notes`, and a Nalanda export maps
      it back. A libib-style file with a `location` column fills it too: an unrecognized column
      would otherwise land in `details`, which share pages and connections show.

    **Chosen without asking, overrulable:** the scan and search result cards' one-click "Add to
    shelf" doesn't ask for a location — it stays one click, and the edit form is a click away;
    a location isn't a shelf-table column; its search in a shelf's box is a substring match, like
    title and creators there; a pasted line break becomes a space.

**2026-09-30 — series:**
52. **An item can belong to a series: a `series` table, and a series id and number on the item.** The owner
    asked for "The Expanse, #3" — numbers fractional ("2.5") or missing — filled in when adding, always editable,
    with a view of the volumes held, the numbers missing, an optional total, and each member's next volume.
    - **A table, not plain columns.** A series has one property of its own, the total, and a name that is
      renamed as a whole; as text on every item, a total would be copied onto each volume and disagree, and a
      rename would rewrite them all. So `series` (name, `key`, total) and `items.series_id` / `series_number`
      (REAL, so 2.5 fits and sorts). The name is unique by `key` — the name NFC-normalised, stripped of control
      and format characters, spaces collapsed, lowercased in JavaScript — because SQLite's `NOCASE` and
      `lower()` fold ASCII only; the first spelling written stays the name. Not book-only: any item may have a
      series, and the form offers it on every type; only book providers fill it. The reference has no
      `ON DELETE` (drizzle-kit drops it on `ALTER TABLE`, §16 #35), so a series is deleted only when nothing
      points at it: `pruneSeries()` rides in the batch of every write that can empty one — an edit that moves
      or clears an item's series, deleting an item, deleting a shelf. Its total goes with it.
    - **What the providers return** (checked live on 2026-09-30; responses recorded in
      `test/fixtures/series-responses.ts`). Open Library's search index carries `series_name` and
      `series_position` as parallel lists on many works — The Expanse #3, Discworld #8, Harry Potter, Dune,
      The Kingkiller Chronicle #1, The Witcher at "0.5", and The Lord of the Rings omnibus at "1-3" — and
      nothing on others (A Wizard of Earthsea, The Hobbit, the Expanse novellas). Both of our field lists now
      ask for them; the first series is taken, and a position that isn't one number keeps the series without
      one. Its edition records have a free-text `series` ("The expanse -- bk. 1") that would cost another
      request and a guess; not used. **Google Books never names a series**: `seriesInfo` is absent from nearly
      every volume (The Expanse, in print and as ebooks, and Harry Potter among them); the few that carry it
      (Play Books comics) give a `bookDisplayNumber` and a `seriesId`, and `/books/v1/series/get`, which has the
      name, answers 401 to an API key — it wants OAuth. A number with no series fills nothing, so it's unread.
    - **Gaps** are the whole numbers from 1 to the highest held — or to the total, once set and higher — that
      no volume carries. A fractional volume fills no whole number and is never missing itself (nothing says a
      1.5 exists); a number held twice (two editions) counts once; volumes without a number count for nothing
      and are listed last. A volume logged but not owned (`copies = 0`) is in the catalog, so it isn't a gap —
      it shows its "Not owned" badge instead. Computed from the numbers held, linear in them, and long runs
      fold ("#6–40") so a typo can't fill a page.
    - **Next up** is the lowest-numbered volume the signed-in member hasn't finished — a finished read of
      theirs (`reads.reader_id`), never the household's status — counting a number finished in any edition,
      and preferring the edition they're reading. Missing numbers between their last finish below it
      (whole numbers only: a finished #2.5 says nothing about #2) and it are named ("#4 comes first —
      not in the catalog"); with every numbered volume finished it points at the
      next missing number, if the series is known to go on. Unnumbered volumes have no place in the order.
    - **Where it shows.** A book's page gets a Series section — the numbers as a strip (held, current,
      finished by you, missing), the gaps, next up — for one batch, one D1 call (a page measured 10 calls with
      a series, 9 without). `/series` lists every series (4 calls), `/series/:id` orders the volumes with the
      missing numbers in their places (4 calls) and renames — a name another series already has merges the
      two, the total given, else theirs, else this one's, kept — or sets the total. Any member may, as with any
      catalog edit.
    - **Share pages: the name and number only.** They are public catalogue data, like the publisher, so a
      shared item's page shows "Series: The Expanse #3" through `toPublicItem(item, { series })` — the key
      only when the route passes the item's own series row, so listings, connections (`toConnectionItem()`)
      and every other caller serve exactly what they did. The gaps say what the household lacks and next up
      is one member's reading: neither appears, and nothing links to the in-app series pages (§9).
      Connections get nothing new; adding it there is a later, optional protocol field.
    - **Portability.** The export gains `series`, `series_number` and `series_total` (repeated per volume);
      a Nalanda re-import restores them, a number or total that isn't one is dropped, and a non-empty total
      sets the series'. libib documents `group` as "what series an item belongs to", so it becomes the series
      — and still a tag, as before, so nothing that relied on the tag changes; libib has no number. Goodreads
      has no series column but its titles carry "(The Dark Tower, #1)" — 94 of production's 1,998 titles did —
      so an added book's suffix becomes its series and leaves the title (the first series of "(Discworld, #8;
      City Watch, #1)"; an omnibus "#1-4" keeps the series, no number). A Goodreads merge never touches
      bibliographic fields (§16 #14), so a book already here keeps its title and gets no series, and matching
      already ignores the suffix, so re-runs still match. The backup exports `series` before `items`.
    - **No backfill** (the owner's call): the migration only adds the table and two empty columns, and
      existing items stay blank until edited; the metadata backfill never writes a series. Rehearsed on
      production's backup of 2026-09-29 (0000–0027, the per-table restore in `TABLES` order, then this
      migration): all 29 pre-existing tables identical in every pre-existing column, row for row, 1,998 items
      in no series, foreign-key and integrity checks clean, the search index rebuilt.

    **Chosen without asking, overrulable:** gaps count logged-but-not-owned volumes as held; next up may be a
    volume not owned, and names missing numbers before it rather than pointing at them; a series with no
    volumes left is deleted, total and all; a rename onto a taken name merges rather than refuses; libib's
    `group` is kept as a tag too; a Goodreads suffix is stripped from the title of a book the import adds; a
    form without the series fields (one opened before this release) leaves the series alone; share listings
    and connections don't carry the series; the series field shows for every media type.

**2026-09-30 — the play log:**
54. **Board games and records get a play log: each play a dated row, the household's, beside —
    not inside — their reads.** A game's shelf life is how often it comes out; a record's, how often
    it goes on. A read (#41) says someone started and finished something, which fits a book and
    barely fits a game. The owner decided the shape: a **Played** button on a board game's and a
    record's page records a play dated today, with a date field beside it to pick another day; the
    page says "Played 12 times · last on 14 Sep" over the five most recent dates, and **All N plays**
    lists every one, a hundred a page under a heading per year. **A play is the household's**: no
    players, winners, scores or durations — a count, and the days. `logged_by` keeps who pressed the
    button, for auditing and for who may **remove** a play: whoever logged it, or an admin — checked in
    the route (403 with a reason) and again in the DELETE (`allowed()`, as #43's writes are). Only
    admins see who logged each, and only once the household has more than one member. Not for books:
    books have reads. The route and the INSERT both refuse any type but `boardgame` and `vinyl`
    (`PLAYABLE_TYPES` in `src/lib/plays.ts`).

    The design questions, answered:
    - **Plays and reads stay apart, and nothing about reads or status changes.** Records and games
      keep the per-member reads the edit form has always kept (#43), and the Reading list their page
      shows in a household of more than one. `plays` is a new table, and nothing on `items`
      summarizes it — no `play_count` column, unlike `read_count`. So a play writes no item column,
      moves no `updated_at`, and fires no trigger: no status filter, share view, connection view or
      activity log can see it. The page counts plays with one indexed statement instead, which the
      budget affords (below). A play is one INSERT with nothing depending on it, so #39's "a write
      and its dependents in one batch" is met by the statement alone.
    - **Share pages say how many, never when.** A shared game's or record's own page shows
      "Played N times" from the first play (`playCount`, through `toPublicItem(item, { plays })`),
      always on, like `readCount` — the count is catalogue-level, harmless, and says something about
      the object. Never a date, the last play, or who logged one (§9). The count is looked up for
      every id the item route is asked, in the same `Promise.all` as the item, so a hit still costs
      what a miss does (a test holds a shared game's hit to a miss's D1 calls). Listing cards don't carry it: a
      page of cards would need an aggregate query for a glance's worth of information.
    - **Plays don't go to connections — not in this change.** `toConnectionItem()` calls
      `toPublicItem()` without a count, so no `playCount` key; no feed kind, no trigger. If they go
      later, they must follow #45 — resolved at serve time, household entries with no `by` unless
      names are on — and a new feed kind is skipped by older peers (#35), which keep the page.
    - **Later work reads the table by its indexes.** `idx_plays_item_played (item_id, played_on)`
      serves an item's count, last and recent plays and "last played" per item (`max(played_on)`
      per group, from the index — "what should we play tonight"); `idx_plays_played_item
      (played_on, item_id)` serves plays in a date range grouped by item ("year in review"). A test
      reads the query plans for both.

    **Portability.** The export gains a `plays` column: the dates, oldest first, each with who logged
    it as the reads cell names readers — `2025-09-14@asha;2025-09-20@` (percent-encoded; an empty
    name a former member; no `@` the importer's). An admin's import gives each play back to the
    member of that name, or to the importer; a member's import is all theirs, as #43 does for reads.
    An export from before plays has no such column, and its games and records arrive unplayed; a
    date that isn't one, or is in the future, is dropped from a cell and the rest kept. A libib file
    that happens to carry a `plays` column keeps it out of `details`, which share pages show. Plays
    aren't in the import preview's per-name tally: who pressed Played isn't anyone's history.
    **Deleting** an item or its shelf deletes its plays (ON DELETE CASCADE); **removing a member**
    keeps the plays they logged, unattributed (`ON DELETE SET NULL`, and `deleteUser()` clears it in
    its batch too, as it does `reviews.user_id`); only an admin can then remove one. At most 5,000
    plays an item (a game a day for thirteen years), in the app and in an import, so no page or
    export cell grows without bound. `scripts/backup.mjs` backs the table up after `reviews`.

    **Migration 0030** (generated, one CREATE TABLE and two indexes; it was 0028 until 1.4.0's
    session-key migrations took 0028–0029, and was regenerated unchanged) touches nothing else.
    Rehearsed on a local copy of production's backup of 2026-09-29: 0000–0027, the per-table restore
    in `TABLES` order, then this migration — all 34 pre-existing tables (FTS shadow tables included) identical in row counts and row
    hashes, all 85 pre-existing schema objects unchanged, `plays` empty, no foreign-key violations,
    integrity ok. D1 (budget 50, #37): a game's page is 11 calls (with lending history's), one more than
    without plays, however many plays; a shared item page 5, the same for a hit and a miss; an export page 10 once loans (#57) sit beside plays.

    **Chosen without asking, overrulable:** only board games and records (not `music`, `movie` or
    `videogame`) — one constant; the date defaults to the server's UTC day and may be tomorrow, as a
    read's may; "last on" and the list read "14 Sep", with the year only outside the current one;
    five recent plays on the page; an item whose type changed away keeps its list (to see and remove)
    but loses the button; the share count shows from one play, where `readCount` waits for two — a
    single read is what "Completed" already says, and nothing else says a game was played once;
    the logger is shown to admins only; the 5,000 cap; plays aren't in the import preview's tally.

**2026-09-30 — a record's condition and pressing:**
55. **A record's grades are private columns; its pressing is public `details`, filled from
    Discogs on add and by a refresh that only fills blanks.** The owner decided three things:
    grade each record's media and sleeve by hand, in-app only; take its pressing from Discogs;
    and let a button fill that pressing for records already in the catalog without overwriting
    anything edited by hand.
    - **Grades: two columns, `media_condition` and `sleeve_condition` (migration 0034).** Not
      `details`, for privacy first: share pages render `details` whole and connections get
      its plain values, so a grade there would publish itself. A column is in no whitelist
      until someone adds it (§9), and it filters and exports as its own CSV column. Stored
      as Discogs' marketplace codes — M, NM, VG+, VG, G+, G, F, P, and for a sleeve only
      Generic and No Cover (Discogs' own list, which also has "Not Graded": here that is NULL).
      The form and the imports check the same fixed scale (`parseGrade()`), and an import
      also reads Discogs' wording ("Near Mint (NM or M-)", and "M-"). A grade off the scale
      is refused by the form and dropped by an import — never kept in `details`, where a
      libib import puts columns it doesn't know. Only a record (`vinyl`, `music`) takes a
      grade; a record whose type changes loses them.
    - **Pressing: `details`, as §5 already listed for vinyl.** It is public catalogue data
      and was already in `details` (label, catno, format, year), which round-trips through
      the CSV's `details` column. Added: `country` and `tracklist`, and `label` and `catno`
      now hold every label and catalogue number, not the first. The tracklist is a list of
      tracks and headings (index tracks are followed by their parts), capped at 400 lines.
    - **What goes out.** Share pages show the pressing and the tracklist, folded, on a
      record's page. Connections get what `plainDetails()` has always sent — the plain
      values: label, catalogue number, country, year, format, Discogs id — and not the
      tracklist (or genres), which are lists. Sending them would be a protocol change, an
      older peer's parser drops lists anyway, and the Discogs id it does get finds them.
      No grade goes anywhere outside, and tests compare share pages and the feed, shelf and
      item routes with graded records.
    - **Filled on add.** A Discogs search result has no tracklist, so saving one (the
      candidate form marks itself `source=discogs`) fetches its release once, before the
      write; the release's pressing keys replace the search's in `details`, since both came
      from Discogs a moment ago. Publisher, published and length (the track count) fill only
      when blank. A failed fetch adds the record as the search described it. A barcode
      lookup's candidate now carries the scanned code (EAN-13 in `isbn13`, else
      `isbn10_upc`), so the record can be found again.
    - **Refresh from Discogs: one request per click, blanks only.** It fetches the release by
      `details.discogs_id` when there is one — the full answer — else searches by barcode,
      which gives everything but the tracklist and stores the release id, so the next click
      fetches the tracklist. It writes only `details` keys `discogs_id`, `label`, `catno`,
      `country`, `year`, `format`, `genres`, `tracklist`, and the columns `publisher` (first
      label), `published` (year) and `length` (track count) — each only while blank (absent,
      null, empty text or an empty list). Anything with a value stays, whoever put it there:
      the app keeps no provenance, so "never overwrite a hand edit" is "never overwrite".
      Title, creators, description, cover, barcode, notes and grades are never touched. The
      write is guarded on the four fields it read (`applyPressingFill()`), so an edit saved
      while Discogs was asked wins and the page says to refresh again. A click is the
      session check, one read and one write (3 D1 calls). Discogs' 429 ("busy"), 404, 401
      and timeouts come back as a notice by code, never as text from the URL.
    - **CPU.** Parsing is one pass over Discogs' JSON with caps on every string; tests keep
      a record's page, with a 400-line tracklist, at the same D1 calls as a book's.

    **Chosen without asking, overrulable:** grades are for `vinyl` and `music` both; a field
    the owner cleared is a blank, which a refresh fills again; a record added before this
    keeps the flat format a search gave it, since refresh never replaces a value — clear
    `format` in the details box and refresh to take Discogs' fuller one; by barcode a
    refresh is two clicks to the tracklist rather than two requests in one click; genres
    stay a list and so stay off connections, as before; the refresh never fetches a cover.

**2026-09-30 — session identity:**
56. **A session names an account by its id and a random key, because ids are reused.** `users.id`
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

**2026-09-30 — loans in the export:**
57. **Every loan leaves in the export, in a `loans` cell per item, and a Nalanda import brings
    it back.** Loans are on item pages and the Loans page, but `/export.csv` had no column for
    them, so a restore from the file lost every loan, including who has a book now. **The owner
    chose a `loans` column** on each item's row (after `copies`), holding every loan of the item,
    open and returned, written the way the `reads` cell is (#41, #43):

    ```
    loans  = [loan *(";" loan)]                    in the order they were made (by id), oldest first
    loan   = loaned ".." [returned] "@" borrower *("|" part)
    part   = "due:" date / "contact:" text / "note:" text    written in this order, read in any
    ```

    For example `2024-03-01..2024-03-20@Asha|due:2024-03-15;2026-09-10..@Ravi%20(Riverbank%20library)|contact:ravi%40example.com`.
    Nothing after `..` is a loan still out. Dates are calendar dates. The borrower, contact and
    note are percent-encoded (`encodeURIComponent`), as a reader's name is, so `;`, `|`, `@`, `:`,
    `%`, commas, quotes, newlines and any script arrive encoded and nothing in the cell needs CSV
    quoting. The due date is encoded too, since the item page's lend form stored whatever it was
    sent (it now keeps only a calendar date, as a connection's lend already did). Reading is
    lenient, as with reads: a part that doesn't parse is dropped and the rest kept — one with no
    borrower, a lending date that isn't a date, or a return date that is there but isn't one
    (read as still out, it would say someone has a book that came back). A due date comes back as
    written, even one that isn't a date — loans lent before the form checked can hold free text,
    and the export carries it, so it round-trips (bounded to 200 characters; found by
    nalanda-review); an unknown `|key:` part, from a later version, is ignored; a `%` that isn't
    our encoding is taken as typed. Written in id order and inserted back in the same order, the
    loans keep their relative ids, so every in-app ordering (the Loans page by id, the item page
    by date then id) comes back as it was. `src/lib/loans.ts` holds the grammar;
    `loansForIdRange()` reads a page's loans and `importItems()` writes a row's back, one
    `INSERT … SELECT … FROM json_each` right after the row's item, in the import's batch (#39).
    Older exports have no column and import unchanged, with no loans. No migration.

    **Loans to connected households** are ordinary loans linked through `connection_loans`
    (#29): they export under the borrower they were lent to — "member (household)" — and come
    back as local loans. The link can't be rebuilt from a file (the connection, its request and
    keys aren't in it), so returning an imported one tells the household nothing: 0010's trigger
    needs the link.

    **Decided, and why:**
    - **Re-import.** A Nalanda import adds every row as a new item and never merges — the preview
      has always said that importing the same export twice adds everything twice. Loans go only
      onto the item their row makes, in the same batch, never onto an item already here, so an
      import can't give any item a loan twice. Importing a file twice gives two copies of each
      item, each with the file's loans, as each gets the file's reads, reviews and tags; deleting
      the extra copy takes its loans with it. A match on (item, borrower, loaned_on) was weighed
      and left out: the item is always new, so there is nothing to match against, and the key
      isn't unique inside one item — two copies lent to one person on one day, or a book back the
      same day and lent again, are real, distinct loans the round trip must keep. Making a Nalanda
      import merge onto existing items would change how every column re-imports, not only loans.
    - **More open loans than copies** can only meet inside one row, and every one is kept. The
      free-copy rule governs making a loan (`lendIfFree()`); the app doesn't keep it as an
      invariant — lowering `copies` on the edit form, or the Holding toggle to Not owned, never
      looks at loans, and the item page shows each open loan with its return button either way.
      Refusing one would drop the fact that someone has the book. Once imported, no copy is free,
      so lending refuses until one comes back.
    - **Not owned (`copies = 0`)**: history and open loans both come back, for the same reason —
      a book given away while it was out is a state the app reaches and shows. The lend route
      still refuses a new loan of it.
    - **A member's import restores loans too.** Loans belong to no member: there is no owner
      column, any member lends and marks returned, and nothing records who did. #43's rule that
      a member's import is all theirs attributes reads and reviews; a loan has nothing to
      attribute.
    - **libib and Goodreads files have no loans**, and their mappings don't change — except that
      `loans` joins the libib mapping's known columns, beside `reads` and `reviews`: a Nalanda
      export missing a column is read as libib, and its borrowers would otherwise land in
      `details`, which share pages and connections show.

    **Within the free plan.** One query a page for loans, by id range on `idx_loans_item`, as
    tags, reads and reviews are read (six a page). Encoding and decoding cost about what the rest
    of a row does. Timed in Node on a loaded machine, writing a page of 250 items took 0.8 ms
    warm, 1.1 ms with 1,000 plain loans, 2.0 ms with 1,000 loans whose every text needed
    encoding, and 5.6 ms warm and 8.4 ms cold with 5,000 of those (twenty an item); mapping 250
    import rows carrying 5,000 took 11–12 ms. So an export page also ends once it holds
    `EXPORT_LOANS` (1,000): the loans query reads at most 1,001 rows, the page stops before the
    item they stopped in, and `x-export-next` says where to go on (it now means "more may
    follow", not "the page was full"). An item with more than 1,000 loans of its own goes out
    alone, with all of them, for a seventh query. The Export button needed no change. The route
    without a cursor streams with no loan limit: the whole stream is one invocation, so smaller
    pages would spend D1 calls and save no CPU, and it keeps its six a page of 2,000. On the way
    in, `public/import.js` closes a batch at 1,000 loans as well as at 200 rows (a row with more
    goes alone), and a cell keeps at most `MAX_LOANS_PER_CELL` (1,000), the latest — where the
    loans still out are — so an item lent more than a thousand times comes back with its latest
    thousand. `isIsoDate()` now checks a date by arithmetic instead of a `Date` round trip, which
    cost about a microsecond a date; a test holds the two to the same answers. Tests count each
    page's D1 calls, and the stream's: the same with 5,200 loans as with none. A shelf-scoped page
    counts only its own shelf's loans, however the shelves' ids interleave.

    **Privacy.** `/export.csv` sits behind `requireAuth`; a test's signed-out request is
    redirected and carries none of it. Loans stay out of share pages and connection payloads
    because those render items through `toPublicItem()` and `toConnectionItem()`, which have no
    loan fields. Tests import loans, then check the share list and item pages and a connection's
    shelf and item for every borrower, contact, note and date, while the in-app page shows them.

    **Chosen without asking, overrulable:** the column's place after `copies`; id order rather
    than date order in the cell; the `|key:` form for the optional parts, so a later field can
    join without breaking older readers; dropping a token whose return date is unreadable rather
    than guessing; the 1,000-loan bounds on pages, batches and cells; tightening the lend form's
    due date to a calendar date.

## 17. Appendix: why SSR + htmx and not Next.js / Vite + React

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
- **When we'd switch**: if the app grows real-time features, offline/PWA ambitions beyond
  installing and holding scans (§16 #48 — a static offline page and plain browser JS, no client
  router), or
  heavy in-page interactivity (drag-drop shelf curation, say) — or if you simply decide you
  want to write React. The swap is contained: Hono stays as the API layer, routes already
  speak JSON where it matters, and the SPA mounts in front. Nothing in the data model or
  provider layer would change.
