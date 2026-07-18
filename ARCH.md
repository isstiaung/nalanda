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
Workers has no DOMParser). htmx, Pico.css, and the ZXing-WASM fallback are vendored static
files in `public/`. Dev-only: `wrangler`, `drizzle-kit`, `vitest`.

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
  • session middleware, roles          • CSV export streaming
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
  status       TEXT NOT NULL DEFAULT 'not_started'
               CHECK (status IN ('not_started','in_progress','completed','abandoned')),
  rating       INTEGER CHECK (rating BETWEEN 0 AND 10),   -- half-stars, rendered as 5 stars
  review       TEXT,
  notes        TEXT,            -- private notes — never rendered on share pages
  copies       INTEGER NOT NULL DEFAULT 1,
  began_on     TEXT,
  completed_on TEXT,
  details      TEXT NOT NULL DEFAULT '{}',  -- JSON: type-specific + unmapped import fields
  added_by     INTEGER REFERENCES users(id),
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_items_library ON items(library_id);
CREATE INDEX idx_items_isbn13  ON items(isbn13);

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
- `boardgame`: `{ bgg_id, players_min, players_max, playtime_min, playtime_max, year }`
- `vinyl`: `{ discogs_id, format, label, catno, year, genres }` — format/pressing and
  catalog number are what collectors actually care about.

Ratings and reading status are **per-item, not per-member** in v1 — one shared household
opinion. Per-member ratings are a possible v1.x addition (§14).

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

**Lending**: from an item page, "lend" captures borrower + optional due date; dashboard and
`/loans` show what's out and overdue; "returned" stamps `returned_on`. History is kept.

**Publish a shelf**: admin toggles sharing on a library → a random token mints
`/share/<token>` — a read-only, no-login view of that library (§9). Toggle off (or
regenerate) and old links die instantly.

**Import from libib or Goodreads**: both export CSV. The import page parses the CSV **in
the browser** and posts JSON batches of ~200 rows (this sidesteps the Worker CPU budget,
§12); the format is auto-detected per batch (a Goodreads export always has an
`Exclusive Shelf` column). Known columns map to real columns; anything unrecognized lands
in `details` JSON so the import is lossless. libib rows always insert (`group` becomes a
tag). Goodreads rows **match-and-merge** (§16 #14): a row matching an existing item — by
ISBN-13, then ISBN-10, then normalized title + first-author surname — merges rating,
review, status, read date, and shelves-as-tags onto it (Goodreads wins, but never blanks
a field it has no value for, and never touches copies or bibliographic metadata);
unmatched rows insert with `copies = 0` (reading-log entries, §16 #13) unless Goodreads'
Owned Copies says otherwise. Re-runs are idempotent: previously inserted rows match on
the next run. A dry-run preview shows mapping + match counts before anything is written.
Export is the inverse: `GET /export.csv` streams every field back out.

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
| BoardGameGeek XML API2 | board games | none | ✗ | XML (hence `fast-xml-parser`); name search + `thing` detail; be polite, BGG throttles |
| Discogs | vinyl (all music) | free personal token | **✓ (UPC/EAN)** | 60 req/min with token; returns format, label, catno |

- Providers are called only at add/import time — zero runtime dependency on them for
  browsing, and no background sync to burn anyone's quota.
- Secrets: `DISCOGS_TOKEN` (recommended), `GOOGLE_BOOKS_KEY` (optional) via
  `wrangler secret put`.
- Movies/CDs/video games: schema supports them (manual entry); TMDB/IGDB providers are v1.x
  **only if wanted** — deprioritized per review (§16).

## 8. Auth — family accounts

Multi-user, built into the app (no email infrastructure, no paid services):

- **First deploy** shows `/setup` (only while `users` is empty) to create the **admin**
  account (you).
- **Admin creates family accounts** at `/settings/users`: username + a temp password shown
  once; the member logs in and is forced to set their own password
  (`must_change_password`). No invites, no email, no reset flows — admin can re-issue a
  temp password the same way.
- **Roles**: `admin` = manage users + publish/unpublish share links; `member` = everything
  else (full item/library/loan CRUD). Two roles, no permission matrix.
- Items record `added_by`, so "who added this" is visible on the detail page.
- Password hashing: **PBKDF2-SHA256 (100k iterations) via WebCrypto** — native-speed, fits
  the free plan's CPU budget. Never bcrypt/argon2 npm packages (pure-JS, would blow it).
- Session: HMAC-signed cookie, `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day expiry; per
  request the middleware also confirms the user row still exists → deleting a user is
  instant revocation.
- CSRF: `SameSite=Lax` + an Origin-check middleware on all mutating routes.
- Login throttling: small fixed delay + per-IP attempt counter in D1.

*Why not Cloudflare Access?* It was considered (free ≤ 50 users, zero auth code) but it
gates the whole hostname — which fights the public `/share/*` requirement — and it moves
auth into dashboard config that local dev can't reproduce. Built-in auth is ~150 lines,
portable, and makes share routes trivially public. CF Access remains available later as an
*extra* layer in front if ever wanted.

## 9. Public share links

- Publishing a library sets `share_token` to a random 128-bit value;
  `GET /share/:token` (library view) and `GET /share/:token/items/:id` (item view) render
  read-only pages with **no login**.
- **Field whitelist, not blacklist**: share pages render only title, creators, cover,
  publisher/label, published date, description, media details, tags, rating, review, and
  a derived boolean `inCollection` (`copies > 0`) so reading-log entries (`copies = 0`)
  carry a "Not owned" badge (§16 #13).
  **Never**: private notes, loans/borrowers, the copies count, added_by, or any nav into
  the authenticated app. The whitelist lives in one view module so it can't drift.
- Pages carry `<meta name="robots" content="noindex">` — links are for people you send them
  to, not search engines.
- Unpublish or regenerate the token any time; old URLs 404 immediately.
- **Covers**: share pages need cover images without auth, so `GET /covers/:key` is public
  with random-UUID keys (unguessable, no listing). Acceptable exposure: covers are public
  cover art by definition.

## 10. HTTP surface

```
GET  /setup                    first-run admin creation (404 once a user exists)
GET  /login                    POST /auth/login · POST /auth/logout
GET  /account                  change own password (also the forced first-login flow)

GET  /                         dashboard: libraries, recent adds, loans out
GET  /libraries/:id            item grid/list; filter/sort/paging via htmx partials
GET  /items/:id                detail  ·  GET /items/:id/edit
POST /items                    create  ·  POST /items/:id (update) · POST /items/:id/delete
GET  /add                      add flow: scan | search | manual
GET  /api/lookup               ?barcode=… | ?q=…&type=boardgame → JSON candidates
POST /items/:id/loan           lend    ·  POST /loans/:id/return
GET  /loans                    out + overdue + history
GET  /search                   ?q= — FTS5 across title/creators/description/notes
GET  /tags · GET /tags/:id     browse by tag
GET  /import                   POST /api/import (JSON batches from client-parsed CSV)
GET  /export.csv               everything, streaming; ?library=:id to scope
GET  /covers/:key              cover art from R2 (public, unguessable, immutable cache)

GET  /settings/users           admin: create/remove members, reissue temp passwords
POST /libraries/:id/share      admin: enable/rotate/disable share token

GET  /share/:token             public read-only library (whitelisted fields, noindex)
GET  /share/:token/items/:id   public read-only item detail
```

Every authenticated page route returns a full document normally and a partial when htmx's
`HX-Request` header is present — one handler, two renders, no client router.

## 11. Project layout

```
├── README.md · ARCH.md · CLAUDE.md · runbooks/
├── package.json · wrangler.jsonc     # bindings: DB (D1), COVERS (R2), assets: public/
├── drizzle.config.ts                 # out: './migrations' so wrangler applies them
├── migrations/                       # generated by drizzle-kit + custom (FTS5/triggers)
├── src/
│   ├── index.ts                      # Hono app: middleware (session, roles, origin check)
│   ├── routes/                       # items.tsx, libraries.tsx, loans.tsx, add.tsx,
│   │                                 # share.tsx, settings.tsx, auth.tsx,
│   │                                 # lookup.ts, importexport.ts
│   ├── views/                        # hono/jsx layout + components; share/ has the
│   │                                 # public-field whitelist views
│   ├── db/                           # schema.ts (Drizzle) + queries — only code touching D1
│   ├── metadata/                     # provider.ts + openlibrary.ts, googlebooks.ts,
│   │                                 # bgg.ts, discogs.ts
│   └── lib/                          # auth.ts (pbkdf2, cookie), csv.ts, covers.ts
├── public/                           # htmx.min.js, scanner.js, zxing wasm, pico.css, app.css
└── test/                             # vitest, runs in workerd with real D1/R2 simulators
```

### Dev workflow & first deploy

- **Prereqs**: Node 20+ and a Cloudflare account. `npm install` brings wrangler, hono,
  drizzle, vitest; a `postinstall` script copies the vendored assets (htmx, Pico.css,
  ZXing-WASM) from `node_modules` into `public/vendor/` so versions stay pinned in
  `package.json`.
- **Local dev**: `npm run db:migrate` once, then `npm run dev` — wrangler runs the Worker
  with a *local* D1 (a real SQLite file) and local R2; full offline loop, nothing touches
  the cloud. Local secrets live in `.dev.vars` (gitignored).
- **First deploy** (once):
  1. `wrangler d1 create nalanda` and `wrangler r2 bucket create nalanda-covers`;
     paste the D1 database id into `wrangler.jsonc`.
  2. `wrangler secret put SESSION_SECRET` (plus `DISCOGS_TOKEN` for vinyl lookups, and
     optionally `GOOGLE_BOOKS_KEY`).
  3. `npm run deploy` → applies remote migrations, deploys, prints your
     `https://nalanda.<account>.workers.dev` URL. Visit `/setup`, create the admin
     account, start scanning.
- **Custom domain** (later): add the zone in CF, one route config line. TLS stays free.

## 12. Free-tier budget — and how it shapes the design

| Resource | Free allowance | This app, realistically |
|---|---|---|
| Worker requests | 100,000/day | tens per day (+ occasional share-link visitors) |
| Worker CPU | **10 ms/request** | the binding constraint — see below |
| D1 | 5 GB · 5M row-reads/day · 100k row-writes/day | 10k items ≈ ~20 MB |
| R2 | 10 GB · 1M writes/mo · 10M reads/mo · **$0 egress** | 10k covers ≈ ~0.3 GB |
| Static assets | free, don't count as Worker requests | htmx/css/wasm |
| TLS + workers.dev subdomain | free | — |
| External APIs | OL/BGG keyless · Discogs 60/min · Google free quota | add-time only, single-digit calls |

The **10 ms CPU ceiling** is the one real constraint, and the design bends around it in
three places: CSV parsing happens in the browser (server just validates JSON batches);
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
library** · libib CSV import (lossless, dry-run) + full CSV export · cover backfill for
imported items (client-driven batches, OL → Google Books → Discogs) · responsive UI
(phone-first for scanning).

**v1.x — candidates:**
per-member ratings/status · stats page · bulk edit · TMDB/IGDB providers if movies/video
games ever matter · Cloudflare Access as an optional extra gate · custom domain hookup.

**Non-goals:** multi-tenant SaaS, native mobile apps, offline sync, social features, ebook
file hosting (calibre-web's territory), background jobs of any kind.

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
    same endpoint serves both importers.
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
    manifest, and theme-color metas follow the new palette.

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
