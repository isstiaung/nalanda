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
  series_number REAL,            -- 3, or 2.5 between two; NULL = in the series, number not known
  purchase_price    INTEGER,     -- what was paid, in minor units of purchase_currency (paise, cents; §16 #61) —
  purchase_currency TEXT         -- its ISO 4217 code; both or neither. Private: never published
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

CREATE TABLE reading_goals (     -- each member's "N books in a year" (§16 #49); the count is worked out when asked
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year       INTEGER NOT NULL,
  target     INTEGER NOT NULL,    -- books, 1–1000
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX reading_goals_user_year ON reading_goals(user_id, year);
-- member_activity (§16 #45) gains goal_id → reading_goals(id), goal_target and goal_count, and item_id may be NULL:
-- a goal entry is the only one without an item (§16 #49)

CREATE TABLE wants (             -- each member's want list (§16 #53)
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- deleteUser() also clears it
  created_at TEXT NOT NULL DEFAULT (datetime('now')),                  -- when it was wanted
  PRIMARY KEY (user_id, item_id)
);
CREATE TABLE purchase_links (    -- where to buy an item: pasted, the household's (§16 #53)
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  url        TEXT NOT NULL,       -- an absolute http(s) URL, checked on every way in
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, url)
);
-- shares (§9, §16 #18) gains want_user_id → users(id): a gift list, one member's want list (§16 #53)

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
- `boardgame`: `{ bgg_id, players_min, players_max, playtime_min, playtime_max, weight, year }` —
  `weight` is BGG's complexity rating (`averageweight`, 1–5, two decimals), which "What should we play
  tonight?" filters on with the players and playtimes (§16 #60)
- `vinyl` (and `music`): `{ discogs_id, label, catno, country, year, format, genres,
  tracklist }` — the pressing, from Discogs (§16 #55). `label` and `catno` hold every label
  and catalogue number, joined; `format` is one line (`2×Vinyl, LP, Album, 180 Gram, Red
  Translucent`); `tracklist` is `[{ position, title, duration, artist, index } | { heading }]`.
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
book stays Completed, marked re-reading, until Finish or "Stop re-reading" closes it — and is
listed under In progress too while it's read (§16 #64). Every
read is listed on the book's page, correctable and deletable (§16 #41). Each is its reader's:
the buttons act on the signed-in person's own reads, another member can start their first read
of a book someone else finished, and everyone's reading shows under their name (§16 #43).

**Want to read** (§16 #53): "Want to read" on a book's page — "Want" on a record's or a game's — puts
it on the signed-in member's own want list; the same button on a scan or search result adds an item
not yet in the catalog as Not owned, on the adder's list. Anyone pastes shop links under "Where to
buy". Finishing a book takes it off its reader's list. An admin publishes a member's list as a gift
list — a share link of exactly what they want now, with those links.

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
| Discogs | vinyl (all music) | free personal token | **✓ (UPC/EAN)** | 60 req/min with token; search returns format, label, catno, country, year; the release (`/releases/{id}`) adds the tracklist (§16 #55); its terms require "Data provided by Discogs." beside its data, linked to the release, and a not-affiliated notice (§16 #63); its images are Restricted Data and are never stored (§16 #67) |
| MusicBrainz + Cover Art Archive | a record's cover, only | none | ✓ (a release's barcode) | the only source of a stored record cover (§16 #67): a release by barcode, a `musicbrainz_id` in details, or a confident artist + title search; the archive's front image, its redirect followed only to archive.org; one request a second, with the app's User-Agent |

- **Series** (§16 #52): Open Library's search index carries `series_name` and `series_position` for many
  works, which fill a candidate's series; Google Books never names one (its rare `seriesInfo` holds a number
  and an id, and `series/get` refuses API keys), so it contributes nothing there.
- Providers are called only at add/import time, or when someone asks — "Refresh from
  Discogs" (§16 #55) and "Refresh from BGG" (§16 #60), one request per click — zero runtime
  dependency on them for browsing, and no background sync to burn anyone's quota.
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
- An htmx request the session middleware turns away (signed out, `/setup`, `must_change_password`)
  gets `HX-Redirect` instead of a 302, so the whole page goes to log in rather than htmx swapping
  the login page into a section (§16 #65).
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
  id. A captured In progress also holds a book being read again (§16 #64), as the shelf's
  filter does. (`libraries.share_token` is legacy — migrated into `shares` by 0004.)
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
  the copies count, what was paid (`purchase_price`, §16 #61), added_by, usernames, the dates of anyone's reads or plays, or any nav into the
  authenticated app — and nothing per member
  unless an admin switches names on (below). The whitelist lives in one view module so it
  can't drift.
- **A record's pressing is public; its condition is not** (§16 #55). "Media details" includes
  a record's pressing — label, catalogue number, country, year, format — and its tracklist,
  all in `details`: catalogue data anyone can look up on Discogs. The media and sleeve grades
  describe this household's copy, like the copies count, and live in their own columns, which
  no whitelist carries.
- **Names are the household's choice** (§16 #45) — on for a new instance since reading goals arrived, and as they were
  for one upgraded (§16 #49: an instance that had members before keeps its switches, off unless an
  admin turned them on). `site_settings.names_on_shares`
  (admin-only, on **Shared links**) adds one field to a shared book's page: `reviews`, each
  member's rating and review signed with their **display name** — or "A member", for a member
  without one — beside the household's average. Nothing else changes: reading history stays
  "Read N times", never whose or when; listing cards keep the average; a login username never
  appears. Off, the key is absent and the page is byte for byte what it was.
  Not item data, and so outside the whitelist: a page that shows a board game carries
  BoardGameGeek's "Powered by BGG" logo in its footer, linked to boardgamegeek.com with
  `rel="noreferrer"` (§16 #44).
  Likewise a shared record whose pressing came from Discogs says "Data provided by Discogs." right
  below it, linked to the release's page on discogs.com, with Discogs' not-affiliated notice
  (§16 #63). The link's only item data is the release id the page already lists as "Discogs ID";
  a want list's pages carry no details, and so neither credit nor id.
- **Money is never published** (§16 #61). The purchase price and its currency are columns no whitelist carries, and
  `toPublicItem()` drops money keys — libib's `price`, which a libib import used to put in `details` — from the
  details it publishes, so share pages and connections never carry a price, however it got into the catalog.
- **Who read what is never published.** The shelf's "Read by" filter isn't one of the
  filters a view captures, so no link can be made of it (§16 #43).
- **Reading goals never reach a share page** (§16 #49): no field of `toPublicItem()` carries one, and
  a share page has no person to hang one on. They go only to connections, signed, under two switches.
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
- **Gift lists** (§16 #53): a share can capture one member's **want list** instead of a shelf's
  filters (`shares.want_user_id`, every other filter unset). It shows exactly what that member
  wants now, on any shelf — `shareFilters()` carries `wantedBy` and `itemMatchesShare()` checks the
  item's wanters, so the listing and the item route agree — and never counts towards a shelf's
  visibility. Its pages render `toGiftItem()`, a narrower whitelist built on `toPublicItem()`: title,
  creators, cover, type, publisher, date, length, description, `inCollection` ("On the shelves"),
  and the one field no other public page has, the household's **purchase links** — pasted http(s)
  URLs, opened with `rel="noopener noreferrer"` so the token never reaches a shop. No rating, review,
  reviews, read count, progress, tags or details. Its title is "A want list", or the member's
  display name only while `names_on_shares` is on — never a username. Ordinary shelf and tag shares
  don't show purchase links.
- **"Wanted"** (§16 #53): beside "Not owned", share pages show a derived boolean `wanted` — someone in
  the household wants it and it isn't owned — never whose. `toPublicItem(item, { wanted })` adds the
  key only when true; it is the only public key the want lists added.
- **Front door (optional)**: with the `HOME_SHARE_TOKEN` secret set, anonymous `GET /`
  redirects to that share — the deploy's root doubles as the public library page
  (§16 #21). A stale token falls back to the login redirect.

## 10. HTTP surface

```
GET  /setup                    first-run admin creation (404 once a user exists)
GET  /login                    POST /auth/login · POST /auth/logout
GET  /account                  change own password (also the forced first-login flow) · POST /account/display-name
GET  /goals                    reading goals: your own, or ?member=:id for an admin (§16 #49)
POST /goals                    set a goal (this year or next) · POST /goals/:id/delete — own, or anyone's for an admin
GET  /year-in-review           a year's reading, mine beside the household's, and its plays (?year=YYYY; §16 #59)

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
POST /items/:id/bgg            "Refresh from BGG": one `thing` request by details.bgg_id, fills blanks
                               only (board games; with HX-Request → the details in place, else
                               redirects back with ?bgg=<code>; §16 #60)
GET  /play                     "What should we play tonight?": ?players=&time=&weight=, and ?pick=1
                               (&not=<id>) for one; with HX-Request → the results alone (§16 #60)
GET  /add                      add flow: scan | search | manual
GET  /add/review               ?barcode=…&scanned=… — one scan held offline, looked up (partial; §16 #48)
GET  /api/lookup               ?barcode=… | ?q=…&type=boardgame → JSON candidates
POST /items/:id/loan           lend    ·  POST /loans/:id/return
GET  /loans                    out + overdue + history
GET  /search                   ?q= — FTS5 across title/creators/description/notes
GET  /tags · GET /tags/:id     browse by tag
GET  /series · GET /series/:id  series: volumes in order, missing numbers, the viewer's next up (§16 #52)
POST /series/:id                rename (a taken name merges) and set its total
GET  /wants                    a member's want list (?member=:id — the household's, to look at; §16 #53)
POST /items/:id/want           want=1|0 — the signed-in member's own list
POST /items/:id/links          add a purchase link · POST /items/:id/links/:link/delete — any member
GET  /import                   POST /api/import (JSON batches from client-parsed CSV)
GET  /export.csv               everything; ?library=:id to scope; ?after=:id for one page of 250
                               items or 1,000 loans (x-export-next names the next page) — the
                               Export button's way
GET  /covers/:key              cover art from R2 (public, unguessable, immutable cache)

GET  /settings/users           admin: create/remove members, reissue temp passwords; the household currency
POST /settings/currency        admin: set the household currency — an ISO 4217 code (§16 #61)
POST /shares                   admin: publish a view (captures shelf + filters + name), or wantUserId=:id — a gift list
POST /shares/:id               admin: action=rotate | delete
POST /shares/settings          admin: setting=progress | names (the share-page switches, §16 #34, #45)
POST /settings/users/:id/display-name   admin: set a member's display name (§16 #45)

GET  /share/:token             public read-only library (whitelisted fields, noindex)
GET  /share/:token/items/:id   public read-only item detail

connections between instances — every route 404s without a federation key (§16 #29)
GET  /.well-known/nalanda       public: household name, public key, protocol version, accepts (§16 #58)
GET  /connect                   public: explains an invitation link opened in a browser
POST /federation/connect        public, signed: redeem an invitation
POST /federation/inbox          public, signed by a connection: accept · decline · disconnect · comments ·
                                borrowing · recommendations (§16 #58)
GET  /federation/views          signed by a connection: shared views, their size and recent volume
GET  /federation/feed           signed by a connection: activity in a view since a cursor
POST /federation/feed/check     signed by a connection: which stored entries are no longer shared
GET  /federation/outbox         signed by a connection: messages addressed to it, after a cursor
GET  /federation/shelf          signed by a connection: a page of a shared shelf, with availability
GET  /federation/item           signed by a connection: one shared item in full, with availability
GET  /connections              admin: name, invitations, pending and active connections
POST /connections/…            admin: settings · invites · redeem · confirm · decline · disconnect ·
                                views · follow · purge · unfollow · progress-sharing · names-sharing ·
                                goals-sharing (§16 #49)
GET  /connections/:id/feed      admin: that household's shared views, what you follow, storage
GET  /feed                      members: activity from followed views, with comment threads
POST /items/:id/comments        members: reply in a connection's thread on one of our reviews
POST /feed/comments             members: comment on a connection's review we follow
POST /comments/:id/delete       members: delete our own comment, or any on our review
GET  /borrowed                  members: books borrowed from connections, requests, households
GET  /households/:id/…          members: a connection's shared shelves and items, read live
POST /households/:id/requests   members: ask a connection to borrow a book
POST /borrow-requests/:id/…     members: lend · decline (theirs) · withdraw (ours)
POST /items/:id/recommend       members: recommend a shared item to a connected household (§16 #58)
GET  /recommendations           members: recommended to us, and what we recommended
POST /recommendations/:id/…     members: want (onto their own want list) · dismiss
GET  /federation/export.json    admins: connections data as JSON
```

Every authenticated page route returns a full document normally and a partial when htmx's
`HX-Request` header is present — one handler, two renders, no client router.

## 11. Project layout

```
├── README.md · ARCH.md · CLAUDE.md · runbooks/ · docs/
├── CHANGELOG.md · changelog/         # the release index; one notes file per release (§16 #42)
├── package.json · wrangler.jsonc     # bindings: DB (D1), COVERS (R2), assets: public/
├── drizzle.config.ts                 # out: './migrations' so wrangler applies them
├── migrations/                       # generated by drizzle-kit + custom (FTS5/triggers)
├── scripts/                          # vendor.mjs (postinstall), deploy.mjs, backup.mjs,
│                                     # wrangler-remote.mjs, seed-demo.mjs, backfill-remote.mjs,
│                                     # record-covers.mjs (the one-off of §16 #67)
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
│   │                                 # musicbrainz.ts (a record's cover, §16 #67)
│   ├── federation/                   # connections between instances (§16 #29)
│   └── lib/                          # auth.ts (pbkdf2, cookie), share.ts (public-field
│                                     # whitelist), csv.ts, covers.ts, reads.ts, reviews.ts,
│                                     # plays.ts, names.ts, goals.ts (a goal's pace, §16 #49),
│                                     # record-covers.ts (§16 #67's provenance and SQL)
├── public/                           # app.css, app.js, scanner.js, import.js, covers.js;
│                                     # manifest, icons/, sw.js, offline.html, scan-queue.js,
│                                     # scan-review.js (the installed app, §16 #48);
│                                     # vendor/ (htmx, zxing wasm, eczar fonts) is copied
│                                     # in on install and gitignored
└── test/                             # vitest, runs in workerd with real D1/R2 simulators
```

### Dev workflow & first deploy

- **Prereqs**: Node 22+ (the locked wrangler requires it; CI runs 24, whose npm 11 matches the lockfile) and a Cloudflare
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

Every architectural decision, numbered in the order it was made, one file each under
[docs/decisions/](docs/decisions/). The number is the address: code, tests, CLAUDE.md and the docs cite
a decision as `ARCH.md §16 #N`, and this table resolves it. **To add one:** take the next number,
write `docs/decisions/NNN-slug.md` (heading, date and context as the others have, then the decision:
what was decided, why, what it rules out, which sections it touches), and add its row here. **To amend
one:** edit its file and date the amendment; never renumber or reuse a number. Inside a decision, "§N"
is a section of this document and "#N" another decision.

| # | Date | Decision |
|---|---|---|
| 1 | 2026-07-03 | [Media types](docs/decisions/001-media-types.md) |
| 2 | 2026-07-03 | [URL](docs/decisions/002-url.md) |
| 3 | 2026-07-03 | [Access](docs/decisions/003-access.md) |
| 4 | 2026-07-03 | [Public read-only publishing](docs/decisions/004-public-read-publishing.md) |
| 5 | 2026-07-03 | [Name](docs/decisions/005-name.md) |
| 6 | 2026-07-03 | [ORM](docs/decisions/006-orm.md) |
| 7 | 2026-07-03 | [Rendering approach](docs/decisions/007-rendering-approach.md) |
| 8 | 2026-07-03 | [Cover backfill shipped in v1](docs/decisions/008-cover-backfill-shipped-v1.md) |
| 9 | 2026-07-03 | [Backfill extended: a title-and-author pass, with identity guards for unattended matching](docs/decisions/009-backfill-extended-title-author-pass.md) |
| 10 | 2026-07-11 | [Backups are per-table, data-only exports (`scripts/backup.mjs`)](docs/decisions/010-backups-per-table-data-exports.md) |
| 11 | 2026-07-11 | [Hardening](docs/decisions/011-hardening.md) |
| 12 | 2026-07-11 | [Referrer policy must never be `no-referrer`](docs/decisions/012-referrer-policy-must-never-no.md) |
| 13 | 2026-07-18 | [`copies = 0` means "in the catalog, not in the physical collection"](docs/decisions/013-copies-0-means-catalog-physical.md) |
| 14 | 2026-07-18 | [Goodreads CSV import is match-and-merge](docs/decisions/014-goodreads-csv-import-match-merge.md) |
| 15 | 2026-07-18 | ["Log — not owned" on scan/search results](docs/decisions/015-log-owned-scan-search-results.md) |
| 16 | 2026-07-18 | [Visual identity re-grounded in Nalanda itself: "the manuscript ledger"](docs/decisions/016-visual-identity-re-grounded-nalanda.md) |
| 17 | 2026-07-18 | [Mark: Ratnodadhi in brick](docs/decisions/017-mark-ratnodadhi-brick.md) |
| 18 | 2026-07-18 | [Share links are per-view, not per-shelf](docs/decisions/018-share-links-per-view-per.md) |
| 19 | 2026-07-18 | [Share pages are burst-shielded by a per-isolate memory cache](docs/decisions/019-share-pages-burst-shielded-per.md) |
| 20 | 2026-07-19 | [Production provisioned and deployed](docs/decisions/020-production-provisioned-deployed.md) |
| 21 | 2026-07-19 | [Front door via `HOME_SHARE_TOKEN` (optional secret)](docs/decisions/021-front-door-via-home-share.md) |
| 22 | 2026-07-19 | [Shelf filters are any-of checkbox groups](docs/decisions/022-shelf-filters-any-checkbox-groups.md) |
| 23 | 2026-07-19 | ["What is public" is a screen, not a badge](docs/decisions/023-what-public-screen-badge.md) |
| 24 | 2026-07-19 | [No Cloudflare resource ids in the repo](docs/decisions/024-no-cloudflare-resource-ids-repo.md) |
| 25 | 2026-07-19 | [The test harness follows vitest-pool-workers, and owns its own fetch mock](docs/decisions/025-test-harness-follows-vitest-pool.md) |
| 26 | 2026-07-19 | [Dismissed: GHSA-67mh-4wv8-2f99 (esbuild dev server), tolerable risk](docs/decisions/026-dismissed-ghsa-67mh-4wv8-2f99.md) |
| 27 | 2026-07-19 | [Holding is its own column, and its toggle spans only 0 ↔ 1](docs/decisions/027-holding-own-column-toggle-spans.md) |
| 28 | 2026-07-19 | [Table columns are a per-device choice, kept in localStorage](docs/decisions/028-table-columns-per-device-choice.md) |
| 29 | 2026-07-19 | [Connections between self-hosted instances — approved, built in phases](docs/decisions/029-connections-between-self-hosted-instances.md) |
| 30 | 2026-07-19 | [Fixed: GHSA-rgj7-g3m4-5g8c (sharp, via libheif), with an `overrides` pin](docs/decisions/030-fixed-ghsa-rgj7-g3m4-5g8c.md) |
| 31 | 2026-07-19 | [Share links can capture a tag](docs/decisions/031-share-links-can-capture-tag.md) |
| 32 | 2026-07-19 | [The backfill fills details, not just covers](docs/decisions/032-backfill-fills-details-just-covers.md) |
| 33 | 2026-07-19 | [Bulk backfills run from a laptop, using the app's own matching code](docs/decisions/033-bulk-backfills-run-laptop-using.md) |
| 34 | 2026-07-19 | [Reading progress is a log, not a number](docs/decisions/034-reading-progress-log-number.md) |
| 35 | 2026-07-19 | [Progress reaches connections as a timeline: every update its own feed entry](docs/decisions/035-progress-reaches-connections-timeline-every.md) |
| 36 | 2026-07-19 | [Notifications are in-app, per person, and only about connections](docs/decisions/036-notifications-app-per-person-about.md) |
| 37 | 2026-09-28 | [The D1 limit that binds is 1,000 calls per invocation, and a batch is one call](docs/decisions/037-d1-limit-binds-1000-calls.md) |
| 38 | 2026-09-28 | [CSV export is fetched a page at a time, and the browser joins the pages](docs/decisions/038-csv-export-fetched-page-time.md) |
| 39 | 2026-09-28 | [A change and whatever it owes — a message, a notification, a replay marker — are one batch](docs/decisions/039-change-whatever-owes-message-notification.md) |
| 40 | 2026-09-28 | [Feed activity is dated by when it happened, and an import isn't news](docs/decisions/040-feed-activity-dated-when-happened.md) |
| 41 | 2026-09-28 | [Each read of a book is a row, and a re-read keeps the book Completed](docs/decisions/041-read-book-row-re-read.md) |
| 42 | 2026-09-28 | [Nalanda is released as SemVer versions, starting at 1.0.0, with notes written for whoever hosts it](docs/decisions/042-nalanda-released-semver-versions-starting.md) |
| 43 | 2026-09-28 | [Reads and reviews are each member's; the item keeps the household's summary](docs/decisions/043-reads-reviews-members-item-keeps.md) |
| 44 | 2026-09-29 | [BoardGameGeek's "Powered by BGG" logo sits beside its data](docs/decisions/044-boardgamegeeks-powered-bgg-logo-sits.md) |
| 45 | 2026-09-29 | [Members' names reach share pages and connections only as display names, only while an admin has switched them on — and with both switches off nothing outside changes](docs/decisions/045-members-names-reach-share-pages.md) |
| 46 | 2026-09-30 | ["Read next" suggests from the signed-in member's own reads, at random, in one query](docs/decisions/046-read-next-suggests-signed-members.md) |
| 47 | 2026-09-30 | [Bulk edit is one batch per action, and deleting in bulk is an admin's](docs/decisions/047-bulk-edit-batch-per-action.md) |
| 48 | 2026-09-30 | [The installed app keeps no pages; offline scans are barcodes held on the device, for the account signed in there](docs/decisions/048-installed-app-keeps-no-pages.md) |
| 49 | 2026-09-30 | [Each member can set a reading goal; connected households hear when it's set, passes halfway and is reached — signed, as it happens, never backfilled; and a new instance starts with names and goals on](docs/decisions/049-member-can-set-reading-goal.md) |
| 50 | 2026-09-30 | [Accessibility is checked in two layers, and CI fails on either (§18)](docs/decisions/050-accessibility-checked-two-layers-ci.md) |
| 51 | 2026-09-30 | [An item's location is one free-text column, private like notes, and searchable](docs/decisions/051-items-location-free-text-column.md) |
| 52 | 2026-09-30 | [An item can belong to a series: a `series` table, and a series id and number on the item](docs/decisions/052-item-can-belong-series-series.md) |
| 53 | 2026-09-30 | [Each member has a want list; the household pastes purchase links; an admin can publish one member's list as a gift list](docs/decisions/053-member-has-want-list-household.md) |
| 54 | 2026-09-30 | [Board games and records get a play log: each play a dated row, the household's, beside — not inside — their reads](docs/decisions/054-board-games-records-get-play.md) |
| 55 | 2026-09-30 | [A record's grades are private columns; its pressing is public `details`, filled from Discogs on add and by a refresh that only fills blanks](docs/decisions/055-records-grades-private-columns-pressing.md) |
| 56 | 2026-09-30 | [A session names an account by its id and a random key, because ids are reused](docs/decisions/056-session-names-account-id-random.md) |
| 57 | 2026-09-30 | [Every loan leaves in the export, in a `loans` cell per item, and a Nalanda import brings it back](docs/decisions/057-every-loan-leaves-export-loans.md) |
| 58 | 2026-09-30 | [A member can recommend one of the household's items to a connected household; theirs arrive in a Recommended list, to want or dismiss](docs/decisions/058-member-can-recommend-households-items.md) |
| 59 | 2026-09-30 | [A year in review is one page, in the app only, counted in SQL in one D1 batch: the member's year beside the household's, and the household's plays once](docs/decisions/059-year-review-page-app-counted.md) |
| 60 | 2026-09-30 | ["What should we play tonight?" filters the household's board games by players, time and BGG's weight, in SQL over their `details`; the weight joins `details`, and "Refresh from BGG" fills blanks for games already here](docs/decisions/060-what-should-we-play-tonight.md) |
| 61 | 2026-09-30 | [What was paid is an integer number of minor units with its currency, on every item, in the household's currency. A record's Discogs market value was considered and dropped, because of Discogs' API terms](docs/decisions/061-what-was-paid-integer-number.md) |
| 62 | 2026-09-30 | [The sidebar folds into sections by what you're doing; a device remembers the ones its member opened in a small cookie the server reads, so the first paint is already right](docs/decisions/062-sidebar-folds-into-sections-what.md) |
| 63 | 2026-09-30 | [Discogs' data carries "Data provided by Discogs.", linked to its release, and the terms' notice](docs/decisions/063-discogs-data-carries-data-provided.md) |
| 64 | 2026-09-30 | [A book being re-read counts as In progress, in every status filter, and still as Completed](docs/decisions/064-book-being-re-read-counts.md) |
| 65 | 2026-09-30 | [htmx failures are shown app-wide; an expired session redirects the whole page](docs/decisions/065-htmx-failures-shown-app-wide.md) |
| 66 | 2026-09-30 | [A name search comes eight results a page, best match first, and each result starts on the shelf that holds most of its type](docs/decisions/066-name-search-comes-eight-results.md) |
| 67 | 2026-10-01 | [A record's stored cover comes from the Cover Art Archive or nowhere, never from Discogs; the covers already stored from Discogs are replaced or dropped by a one-off run from a laptop](docs/decisions/067-records-stored-cover-comes-cover.md) |
| 68 | 2026-10-01 | [Rows read are budgeted like calls: pages read in index order, count once, and filter from the small side](docs/decisions/068-rows-read-budgeted-like-calls.md) |
| 69 | 2026-10-01 | [Today is the device's day: a `tz` cookie names its zone, and every date a page offers or a handler fills in is today there](docs/decisions/069-today-is-the-devices-day.md) |
| 70 | 2026-10-01 | [Sign out other devices: a session generation beside the identity key, named by the cookie and moved on by a sign-out, a new password or a reset](docs/decisions/070-sign-out-other-devices.md) |
| 71 | 2026-10-01 | [A share link previews where it's pasted: Open Graph tags carrying only what the page shows, and the page stays noindex](docs/decisions/071-share-page-link-previews.md) |
| 72 | 2026-10-01 | [Creators and publishers are pages: authors, designers and artists read out of `creators`, publishers and labels out of `publisher`, no table](docs/decisions/072-creator-and-publisher-pages.md) |
| 73 | 2026-10-01 | [A cover from the camera: the browser shrinks the picture, the Worker sniffs and stores it, under the rules every cover keeps](docs/decisions/073-cover-from-the-camera.md) |
| 74 | 2026-10-01 | [Deleting an item puts it in the trash for 30 days: a snapshot SQLite builds in the delete's own batch, restored through the import's insert, never a soft delete](docs/decisions/074-item-trash.md) |
| 75 | 2026-10-01 | [Formats are a set on the item, editions are facts about it, and a loan says which copy went out: one item per work](docs/decisions/075-formats-and-editions.md) |
| 76 | 2026-10-01 | [A household default language, every item's own, and an original title in any script; search matches text as written](docs/decisions/076-language-and-original-title.md) |
| 77 | 2026-10-01 | [Quotes are a member's own, private until each is marked shared; Kindle highlights come in as quotes, parsed in the browser](docs/decisions/077-quotes-and-highlights.md) |
| 78 | 2026-10-01 | [Discovery is one page: the works of authors you have finished, from Open Library, on a click — and nothing more](docs/decisions/078-new-from-your-authors.md) |
| 79 | 2026-10-01 | [A series' missing volumes can be found on Open Library, on a click; the household's series data always wins](docs/decisions/079-series-gaps-from-open-library.md) |
| 80 | 2026-10-01 | [Search operators: seven prefixes on the search box, applied inside the one id query; anything else is text](docs/decisions/080-search-operators.md) |
| 81 | 2026-10-01 | [Saved views are the household's: a shelf's filter bar under a name, two decluttering presets, in the app only](docs/decisions/081-saved-views.md) |
| 82 | 2026-10-01 | [Borrowed from someone not on Nalanda: an item not owned, with a borrow record — the mirror of a loan, private like one](docs/decisions/082-borrowed-from-someone.md) |
| 87 | 2026-10-01 | [StoryGraph and LibraryThing exports import as Goodreads' does: matched and merged, the importer's own reads and reviews](docs/decisions/087-storygraph-librarything.md) |

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

## 18. Accessibility

**The bar.** WCAG 2.2 level AA (and so 2.0 and 2.1 A and AA) on every page — the app, the public
share pages, log in and setup, the 404s — in the light and the lamp-lit theme, at desktop and phone
widths, and after every htmx swap. The design system meets it with its own tokens: text keeps
4.5:1 against whatever it sits on, hovered rows included; colour is never the only signal (a pill
has its word, an overdue loan says "overdue", links in running text are underlined); every field
has a name; every signed-in page starts with a "Skip to content" link past the sidebar (share, login and setup
pages have no repeated navigation to skip); keyboard focus survives an htmx swap. Decision: §16 #50.

**Two layers**, both in CI, both dev-only:

- **Static — `npm run lint`** (`eslint.config.mjs`). ESLint with eslint-plugin-jsx-a11y's `strict`
  rules over `src/**/*.tsx` — missing `alt`, a `<label>` with no control, empty headings and links,
  invalid or misused ARIA, roles where an element exists — plus two `no-restricted-syntax` selectors
  for what jsx-a11y can't see in hono/jsx: `autofocus`, and `hx-get`/`hx-post` on an element that
  isn't a form, button or link. No other rules. It sees one component at a time, so what spans
  components — heading order, contrast, a page's landmarks, whether a field ends up named — is the
  runtime layer's. (`control-has-associated-label` stays off: it flags table cells, and components
  whose label arrives as a prop.)
- **Runtime — `npm run a11y`** (`scripts/a11y.mjs`). A scratch `wrangler dev` on 127.0.0.1:8817 with
  its own temporary `--persist-to` state, a throwaway session secret and connections key, seeded by
  `scripts/seed-demo.mjs --no-covers` and furnished further over HTTP (covers from a local image
  server, a second member, a loan past due, a read in progress, published links with names and
  progress on, an empty shelf, a shelf with a second page, a second member, a book series with a
  gap, a location, a returned loan, a graded record with its pressing and tracklist, plays, a reading
  goal, want lists with a purchase link, and a published gift list). Playwright's Chromium
  visits every page in the list, as the admin, as that member and signed out, and runs axe-core's
  WCAG 2.0 / 2.1 / 2.2 A and AA rules, its best-practice rules and the two experimental WCAG ones
  (label in name, bold-paragraph headings), in both themes at 1280 and 390 wide. On a phone it also
  fails a page that scrolls sideways (reflow, which axe doesn't test). It opens every closed
  `<details>` and looks again (the toolbar's menus one at a time); performs the htmx interactions
  from the keyboard and audits what comes back, failing one that drops focus to `<body>`; submits the
  refused and one-time forms (a temporary password, an invitation link, a bulk delete's
  confirmation, a bulk action's notice); loads the Add page with scans held offline, and
  `/offline.html`; opens the phone menu; drives the Refresh from Discogs and Refresh from BGG buttons
  (#55, #60) on a second scratch server (:8819) with placeholder provider tokens — the main one keeps
  none, since a token would send its Add-page lookups to Discogs — where the browser answers each
  refresh itself (a fill in the handler's shape, a dropped connection, a 500) or lets it reach a Worker
  with no id to look up, so nothing reaches Discogs or BGG, checking "Asking…" and the disabled button
  while it waits, the sentence after, focus back on the button (from the keyboard and after a mouse
  double-click), and axe after the swap; and
  walks the keyboard: the first Tab is the skip link, following it lands in `<main>`, every stop
  shows a focus indicator that draws something (an outline not clipped away, a ring that isn't a
  faint tint, or a border that changes), every visible control is reached, and the tab order comes
  back round (no trap). Anything axe can't decide about contrast or target size is listed for a
  person to check. Any violation exits 1 with a report grouped by rule, naming page, theme, width
  and element (on GitHub Actions, the count left for a person is a notice on the run). It waits for
  each htmx swap by htmx's own `htmx:afterSettle`, never by a change in the HTML or a fixed delay, so a
  slow runner checks the same moment a fast one does (`A11Y_CPU_THROTTLE=4` reproduces one). It never
  touches port 8787, the development database or Cloudflare (`--local`, a temporary `--persist-to`, no
  credentials in its environment and wrangler's config home inside that state), and never reads
  `.dev.vars`: the Worker's variables come from an `--env-file` it writes, provider tokens empty, so a
  local run is as offline as CI's (`A11Y_USE_DEV_VARS=1` opts back in). It removes its state and server
  when done.

**The htmx limitation.** The linter can't see `hx-*` behaviour: to it `hx-post` is an unknown
attribute, so a `<div hx-post hx-trigger="click">` — interactive, but not to a keyboard or a
screen reader — would pass. The rule that closes the gap: `hx-get`/`hx-post` go only on forms,
buttons and links, which the browser already makes focusable and operable. Today they are the
Add page's two lookup forms, the Reading section's, play log's, want bar's and Where to buy's forms,
Read next's Another, and the Holding toggle buttons. The runtime layer covers the other half: it
performs those swaps (record, remove a page, add, edit, delete and move a read, finish, stop, read
again, Played and removing a play, the want toggle, adding, refusing and removing a purchase link,
Another, the Holding toggle, both lookups) and audits the page with the new HTML in it. A request that fails swaps nothing: the layout's `#app-status` region says so in a fixed
sentence (§16 #65), and the audit fails Another in the browser to check the page with it showing. A swapped-in error is `role="alert"`, since htmx moves no focus to
tell anyone; and a swap keeps keyboard focus — htmx restores it to an element with the same id, and
app.js gives it to the swapped region otherwise.

**How a new feature meets it.** Use the existing tokens and components; a new colour pairing must
hold 4.5:1 for text in both themes. Wrap each field in its `<label>`, or give it an `aria-label`
where there's no visible one; a refused form's error is `role="alert"`, and the fields it is about
take `invalid(error, id)` (`src/views/components.tsx`). Say state in words or ARIA, not only colour.
Links navigate and buttons act — no `role="button"` on a link. Headings don't skip levels. A new
page joins `pageList()` in `scripts/a11y.mjs`, a new htmx interaction a step in `interactions()`;
then `npm run lint` and `npm run a11y` pass.

**What it doesn't cover.** Automated checks find perhaps a third to a half of real problems;
nothing here replaces trying a page with a screen reader and a keyboard. Not reached: pages that need
another household (a connected shelf, borrow requests and their errors, comment threads — the audit
has no peer); board-game and record lookups (BGG and Discogs need tokens CI doesn't have); the "not
ready yet" page an instance shows without a session secret; hover states (axe never hovers — a hovered
row's contrast was worked out by hand). The Add page's book lookups need Open Library: when it finds
nothing the report lists those states as not audited, as a warning on GitHub Actions, and
`A11Y_REQUIRE_LOOKUP=1` makes that a failure. Text under an open menu, and symbols (the stars, media
icons), are contrast checks axe leaves to a person; the report counts or lists them. Ratings read to a
screen reader as their star glyphs.
