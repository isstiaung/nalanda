# CLAUDE.md

## Project
**Nalanda** — self-hosted, libib-style library manager for a household: catalog **books,
board games, and vinyl records**, add by barcode scan (books/vinyl) or name search (board
games via BGG), auto-fill metadata + covers, tags, loans, public read-only share links, CSV
import/export. Multi-user (admin + family members). **$0/month hosting is a hard
requirement.**

[ARCH.md](ARCH.md) is the source of truth for architecture decisions — read it before
structural changes. Its §16 indexes the decision log, one file per decision in
[docs/decisions/](docs/decisions/), cited everywhere as "ARCH.md §16 #N": add a file and an index
row when a decision is made, amend the file when one changes. This file is the short operating
manual. The long forms: [docs/privacy.md](docs/privacy.md) (every privacy rule by
surface), [docs/conventions.md](docs/conventions.md), [docs/layout.md](docs/layout.md).

MIT. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md); vulnerabilities: [SECURITY.md](SECURITY.md);
dependency licences: [THIRD-PARTY.md](THIRD-PARTY.md). Deployment (resources, secrets, git
integration, rollback) is in [runbooks/deploy.md](runbooks/deploy.md) — never assume a
deployment's shape from this file.

## Stack (settled — don't re-litigate without updating ARCH.md)
- TypeScript on Cloudflare Workers. Hono + `hono/jsx` SSR, htmx partials. No SPA, no React,
  no client-side bundler (ARCH.md §17).
- D1 (SQLite) + **Drizzle ORM**: schema in `src/db/schema.ts`; `drizzle-kit generate` emits SQL
  into `migrations/`; **wrangler** applies them (one runner). FTS5 + its sync triggers are a
  hand-written `drizzle-kit generate --custom` migration — Drizzle's DSL can't express them.
- R2 for cover art. Metadata providers behind `src/metadata/provider.ts`: Open Library + Google
  Books (books, keyless-capable), BoardGameGeek XML API2 (games: name search only, no barcode
  lookup, needs `BGG_TOKEN` — registration-only since 2025), Discogs (vinyl, **has** barcode
  search, needs `DISCOGS_TOKEN`). A record's stored cover comes only from the Cover Art Archive via
  MusicBrainz (`recordCover()`, keyless, one request a second) — **never a Discogs image**
  (Restricted Data); `fetchCover()` refuses discogs.com hosts on every path (ARCH.md §16 #67).
- Styling: the hand-written design system in `public/app.css`, "the manuscript ledger" (ARCH.md
  §16 #16) — no CSS framework. Indigo working accent; vermilion only for circulation/danger;
  turmeric gold for ratings; monospace for all data (counts, ISBNs, dates, pills, `accNo()`);
  Eczar for page titles and brand only; light + lamp-lit dark via `prefers-color-scheme`; the
  vermilion headstroke rule lives in `.brand-rule` only. Extend the existing tokens/components
  (`.pill`, `.data-table`, `.props`, `.eyebrow`) — don't add frameworks (docs/conventions.md).
- htmx and ZXing-WASM are pinned devDependencies copied to `public/vendor/` by
  `scripts/vendor.mjs` (postinstall) — never hotlinked from a CDN, never imported into the
  Worker bundle.
- Tests: Vitest + `@cloudflare/vitest-pool-workers` (real workerd), plain Vitest config plus the
  `cloudflareTest()` plugin. `test/apply-migrations.ts` resets and re-migrates D1 before every
  test; `test/fetch-mock.ts` stubs outbound fetch (ARCH.md §16 #25; docs/conventions.md).
- Runtime npm deps: `hono`, `drizzle-orm`, `fast-xml-parser` (BGG is XML; Workers has no
  DOMParser). Adding another needs a strong reason.

## Hard constraints (Cloudflare free tier)
- Free plans only: Workers, D1, R2. Never introduce paid CF features (Images, Queues, paid
  Durable Objects) or any AWS service.
- **10 ms CPU per request**: no server-side image processing; no server-side bulk parsing — CSV
  imports are parsed in the browser and posted as JSON batches; the Export button fetches
  `/export.csv` 250 items a request (`?after=<id>`) and joins them in the browser (ARCH.md §16
  #38). A page also ends at 1,000 loans, and an import batch closes at 1,000 (§16 #57).
- **D1 calls per invocation: design to 50; the measured cap is 1,000** (ARCH.md §16 #37), and a
  `batch()` counts as **one** call. `waitUntil` work belongs to the page's invocation.
  Connections' background work runs through the budgeted handle in `src/federation/budget.ts`;
  tests count queries per page load with it (docs/conventions.md).
- Password hashing is WebCrypto PBKDF2 only (100k iterations — also workerd's cap). Never add
  bcrypt/argon2 packages (pure-JS, blows the CPU budget).
- Workers is not Node: no `fs`/`net`/native modules, no `nodejs_compat` flag — fetch, WebCrypto
  and Web Streams only.
- Data portability: every user-visible field must round-trip through `/export.csv`; a new column
  isn't done until export and import mapping cover it. Reading goals are the exception: about
  people, not items; backups carry them (ARCH.md §16 #49).

## Privacy invariants
Each is a hard rule. [docs/privacy.md](docs/privacy.md) has every one in full, by surface, with
the code that enforces it and why — read its section before changing anything a surface shows.
- **Share pages** (`/share/:token`, `noindex`) render only the `toPublicItem()` whitelist
  (`src/lib/share.ts`); never add a field there without checking ARCH.md §9.
- Never on share pages: private `notes`, `location` (never published, never a key of
  `toPublicItem()` or `toConnectionItem()`), loans/borrowers, the `copies` count, a record's
  condition, money, `added_by`, usernames, reads or their dates, whose reads, links into the
  authenticated app, or anything per member unless names are switched on.
- Share pages may show only these derived values: `inCollection` ("Not owned"); `readCount` from
  two on; a game's or record's `playCount` (never a play's date or who logged it); series name and
  number on the item page (never the gaps or anyone's "next up", not on listings or to
  connections); the household rating (average) and latest review, no author; progress only with
  `progress_on_shares` on and only for a book being read now. A Not owned item never claims a read.
- Never capture the **"Read by" filter** (`ReaderFilter`, kept out of `ItemFilters`) or the search
  box `q` (it matches `location`) in a share link or connection view.
- Share tokens: random 128-bit, one per published view. `itemMatchesShare()` and `shareFilters()`
  must stay in step (status via `matchesStatus()`/`statusWhere()`). Publish/rotate/remove and
  `/shares` are admin-only. A shelf is "Shared" only when a filterless link exposes it entire.
  Share pages cache 1 h per isolate; rotation can lag that long.
- **Names outside the app** are only a member's **display name**, never a username, and only while
  an admin's switch is on (`names_on_shares`, `names_to_connections`); an upgrade never flips a
  switch. With both off, every served byte stays as before (no `reviews` or `by` key).
- Resolve names when serving, never when recording: `member_activity` points at a read, review,
  page or goal, never a person. Per-person entries are recorded only as they happen — never
  backfilled, never dated by a read's dates. Renames, removals and moves re-key them.
- Comments, borrow requests and recommendations are signed with `outwardName()` — the display
  name or "A member", never the username.
- **Reading goals** never reach a share page. To connections only while `names_to_connections` and
  `goals_to_connections` are both on, only for a member with a display name (never "A member"),
  never with an `item` (the only item-less kinds); never backfilled or dated by a read. What counts
  is `goalCountSql()`.
- **Gift lists** render only `toGiftItem()` (no rating, reviews, read count, progress, tags or
  details); titled "A want list", or the display name only while `names_on_shares` is on — never a
  username. They never count towards a shelf's visibility; `shareFilters()` and
  `itemMatchesShare()` must agree on `wantedBy`. Removing a member deletes their wants and gift
  lists in `deleteUser()`'s batch.
- **"Wanted"** is a boolean, added only when asked and only while not owned — never whose want,
  never a count.
- **Purchase links** are pasted, never generated, and public only on gift lists — never on a
  shelf's share page or to connections. `checkPurchaseLink()` takes only absolute http(s) URLs
  without credentials, on the way in and out; render `target="_blank" rel="noopener noreferrer"`
  so a share token never reaches a shop.
- A record's **condition** is never published (share pages or connections); never move a grade
  into `details`, and an import drops an off-scale grade. The pressing in `details` is public;
  connections get its plain values, not the tracklist.
- **Money is never published**: `purchase_price`/`purchase_currency` are never keys of
  `toPublicItem()`/`toConnectionItem()`, and never move a price into `details` (`toPublicItem()`
  strips `MONEY_DETAIL_KEYS`). Money is never a float (`parseMoney()`, `CAST(sum(…) AS TEXT)`,
  `formatMoney()`); never add two currencies together.
- **Connections** see only `toConnectionItem()` fields, only for items inside a connection view:
  availability a boolean (never borrower, due date, copies or `location`); reading history a count
  (never the reads, their dates or readers); rating and review the household summary, names only as
  above. A view filtered to In progress serves only reading still going on (`readingInView()`).
  Activity triggers record only while a connection view exists, dated when it happened; imports
  bracket themselves with `import_in_progress`.
- **Recommendations** send only `toRecommendedItem()` — never a username, the ISBN or barcode
  columns, or anything `toConnectionItem()` lacks; only for an item inside a connection view, only
  to a household whose `accepts` lists `Recommend` (a new directed type: advertise it in `ACCEPTS`,
  check `peerAccepts()`). The receiver's want/dismiss is never sent back. A peer's cover: raster
  types only, no redirects, served with a sandboxing CSP.
- Strings from another instance render only as escaped text — never inside an inline handler such
  as `onsubmit="confirm('…')"`. A comment thread is shown only to its two households.
- `/covers/:key` is public by design: keys are random UUIDs — never enumerable or derived from item
  data.
- Discogs' credit ("Data provided by Discogs." + their notice): `discogsLink()` decides — never on a
  record typed in by hand — and builds the href from a numeric release id only. Never `nofollow`.
- **The service worker never stores a page or an API answer** — only `STATIC` in `public/sw.js` —
  and leaves `/share/*` alone. Offline scans hold a barcode and a time only and belong to the
  signed-in account (another account's pages or logout empty the queue; POST /items refuses
  anyone else's held scan via `scanOwner`). Bump `VERSION` in sw.js when `STATIC` or its behaviour
  changes. The browser keeps no signed-in answer either: every response behind the session
  middleware is `Cache-Control: no-store` (set in `src/index.ts`) and logout sends
  `Clear-Site-Data: "cache"`; `/share/*`, covers, static files and the login page cache as before.

## Commands
```
npm run dev                # wrangler dev — local D1 (real SQLite file) + local R2, offline
npm run dev:demo           # same, on :8788 with its own --persist-to state (screenshots)
npm run seed:demo          # fills that demo instance over HTTP; refuses a non-empty one
npm test                   # vitest, runs inside workerd
npm run typecheck          # tsc --noEmit
npm run lint               # eslint-plugin-jsx-a11y (strict) over src/**/*.tsx + no-restricted-syntax
                           # (hono's `autofocus`, hx-* off forms/buttons/links) — no other rules
npm run a11y               # axe-core WCAG 2.2 A/AA, every page, both themes, 1280 + 390, htmx swaps,
                           # keyboard; own servers on 127.0.0.1:8817/:8819 with temp state —
                           # never 8787 or your dev DB, never Discogs or BGG (ARCH.md §18);
                           # `npx playwright install chromium` once
npm run db:generate        # drizzle-kit generate — schema.ts → migrations/*.sql
npm run db:migrate         # wrangler d1 migrations apply nalanda --local
npm run db:migrate:remote  # same, against production (via wrangler:remote)
npm run wrangler:remote -- <args>  # any wrangler command against production D1 (real id → temp config)
npm run deploy             # needs D1_DATABASE_ID in the env, never in the repo; migrates, deploys
npm run backup             # per-table data-only export → backups/remote-<date>/ (D1 can't dump
                           # FTS5; schema comes from migrations/ — backup runbook)
npm run backup:local       # same, for the local dev database
npm run backfill:remote -- <step>  # production covers + descriptions: rehearse | export | enrich |
                           # upload | apply | status; apply wants a backup < 12 h old (runbook)
npm run record-covers:remote -- <step>  # one-off: record covers stored from Discogs → the Cover Art
                           # Archive's, or dropped; same steps (runbooks/record-covers.md, §16 #67)
npm run vendor             # re-copy vendored assets after bumping htmx/zxing/font versions
npm run federation:keygen  # Ed25519 identity → FEDERATION_PRIVATE_KEY, printed once, never on disk
```

## Layout
File by file: [docs/layout.md](docs/layout.md). The rules it carries:
- `src/index.ts`: route order matters — public (share, covers, auth) first, then `requireAuth`,
  then protected routes; Origin-check CSRF on mutations.
- `src/db/` is the ONLY code touching D1 (`schema.ts`, `queries.ts`, `federation.ts`);
  `src/metadata/` the only code calling external APIs; `src/lib/covers.ts` the only R2 code.
- `src/routes/share.tsx` is the public share pages, `shares.tsx` admin share management — don't
  confuse them. Whitelists: `src/lib/share.ts` (public), `src/federation/items.ts` (connections).
- `migrations/` is append-only. `changelog/` holds `vX.Y.Z.md` per release and `unreleased.md`;
  CHANGELOG.md is their index. `docs/decisions/` holds one file per decision; ARCH.md §16 is
  their index, and "ARCH.md §16 #N" stays the citation.
- `.github/`: CI has no secrets and never uses `pull_request_target`; the release workflow never
  deploys. `docs/screenshots/` come from seeded demo data — never real catalog data. Update
  `runbooks/` when ops procedures change.

## Conventions
Long forms in [docs/conventions.md](docs/conventions.md).
- **Commit after every completed feature or architectural unit**, conventional messages (`feat:`,
  `fix:`, `docs:`, `chore:`, `test:`); never batch unrelated changes into one commit. Push only
  when asked.
- **Releases** (ARCH.md §16 #42) are SemVer; PRs add their entries to `changelog/unreleased.md`.
  A release commit: `npm version X.Y.Z --no-git-tag-version` and `src/version.ts` (a test checks);
  rename `changelog/unreleased.md` to `changelog/vX.Y.Z.md`, headed `## [X.Y.Z] - <date>` with a
  one-sentence summary; a fresh `unreleased.md`; the version's line in the CHANGELOG.md index. A
  migration that changes data (and whether to back up), a new secret, connections on older
  versions, or any manual step must be in its **Upgrading** block. After it merges, tag main
  `vX.Y.Z`; the release workflow publishes that file (only for tags on main).
- One handler, two renders: a full page normally, a partial when `HX-Request` is present.
- Today is the device's day (ARCH.md §16 #69): `todayOf(c)` reads its `tz` cookie; a route never takes a
  day from `new Date()` or SQL's `date('now')` — a handler given no date passes `todayOf(c)` to the query.
- Accessibility (ARCH.md §18): WCAG 2.2 AA in both themes. `hx-*` only on forms, buttons and links;
  every field labelled; errors `role="alert"` (+ `invalid()`); colour never the only signal; a new
  page or htmx swap joins `scripts/a11y.mjs`; `npm run lint` + `npm run a11y` pass.
- Mutations are POSTs; CSRF = `SameSite=Lax` session cookie + Origin check. Cookies set `Secure`
  only on https.
- A write and whatever depends on it are **one batch** (ARCH.md §16 #39) — its queued message,
  notification, replay marker, an item and its tags. Nothing after the batch may be able to fail
  the request.
- Auth (ARCH.md §8): roles are just `admin`/`member` — no permission matrix; admins create members
  with one-time temp passwords. User ids are reused, so a session names the id **and**
  `users.session_key` (set in every user insert, never changed); anything that remembers a person
  across time binds `accountIdentity()`, never the bare id. Beside it, `users.session_generation`
  (ARCH.md §16 #70) is which sessions still count: the cookie names it, and "Sign out other
  devices", a password change and a reset each add one — never rotate the key for that. Login and
  the current-password check are throttled by `recordLoginAttempt()`: ten failures in ten minutes
  per IP and per account, counted in the statement that checks, *before* the password is verified,
  answered 429; an unknown username is checked against `DUMMY_HASH`. A temporary-password session
  reaches only `GET /account` and `POST /account/password` (`mustChangeMayReach()`).
- Never hand-edit drizzle-generated migrations (hand-written SQL goes in `--custom` ones); never
  edit a migration that has been applied anywhere.
- Barcode routing (`src/metadata/index.ts`): EAN-13 `978`/`979` → book providers (merged); an
  ISBN-10 (nine digits and a check digit, `X` allowed) likewise, kept as `isbn10Upc` with its ISBN-13
  derived (`isbn13Of()`) unless Google Books names one; any other EAN/UPC → Discogs. Tags are
  normalized lowercase at write time; uniqueness by exact string.
- Reads (`reads`, one row per read, each with its reader) and reviews (`reviews`, one per member
  per item) are per member. The `items` summary columns (`status`, `began_on`, `completed_on`,
  `read_count`, `rereading`, `progress_page`, `rating`, `review`) are written only by
  `refreshReadState()`/`refreshReviewState()` in the same batch — never directly. Never compare
  `items.status` to a filter by hand: `matchesStatus()`/`statusWhere()` (a re-read is In progress
  **and** Completed, pill "Re-reading"). One open read per person per item; a finished book takes no
  page until "Read again". `reviewed_at` moves only when the text changes; a write that can remove
  a review carries `redateReviewActivity()`. Only an admin's import keeps a file's names.
- Members change only their own reads, pages and review; admins anyone's, and only admins move one
  to another member — checked in the route (403 with a reason) *and* the writing statement
  (`Actor` guards).
- `copies = 0` = catalogued, not owned: not lendable, badged "Not owned" everywhere incl. share
  pages. The Holding toggle spans only 0 and 1; the route refuses to zero 2+ copies (§16 #13, #27).

## Ops guardrails
- Develop against local D1. `--remote` is for deploy, remote migrate, backup, and
  `backfill:remote` / `record-covers:remote` only.
- Any destructive remote operation (dropping data, hand-run `wrangler d1 execute --remote`)
  requires a fresh `npm run backup` first.
- Secrets (`SESSION_SECRET`, `DISCOGS_TOKEN`, `BGG_TOKEN`, optional `GOOGLE_BOOKS_KEY`, optional
  `HOME_SHARE_TOKEN` — logged-out `/` shows that share, §16 #21) via `wrangler secret put` —
  never in code, `wrangler.jsonc`, or git. Local values go in `.dev.vars` (gitignored).
- **`FEDERATION_PRIVATE_KEY`** is this instance's identity to its connections: a runtime secret,
  never in git or D1, so not in backups — losing it means reconnecting with every household.
  Unset, connections are disabled and every connections route 404s.
- **No Cloudflare resource ids in the repo** (ARCH.md §16 #24): `database_id` stays the all-zero
  placeholder, deploys supply `D1_DATABASE_ID`. Don't "helpfully" fill it in — miniflare keys
  local D1 state by it, so editing it orphans the local database (§16 #20).
- Keep this file, docs/ and ARCH.md current as commands and decisions evolve.
