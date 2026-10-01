# CLAUDE.md

## Project
**Nalanda** — self-hosted, libib-style library manager for a household: catalog **books,
board games, and vinyl records**, add by barcode scan (books/vinyl) or name search (board
games via BGG), auto-fill metadata + covers, tags, loans, public read-only share links, CSV
import/export. Multi-user (admin + family members). **$0/month hosting is a hard
requirement.**

[ARCH.md](ARCH.md) is the source of truth for architecture decisions — read it before
structural changes, update it (incl. §16 decision log) when a decision changes.

Open source under [MIT](LICENSE). Outside contributions come through
[CONTRIBUTING.md](CONTRIBUTING.md); vulnerability reports through
[SECURITY.md](SECURITY.md); dependency licensing is tracked in
[THIRD-PARTY.md](THIRD-PARTY.md). Deployment (resources, secrets, git integration,
rollback) is in [runbooks/deploy.md](runbooks/deploy.md) — never assume a deployment's
shape from this file.

## Stack (settled — don't re-litigate without updating ARCH.md)
- TypeScript on Cloudflare Workers. Hono + `hono/jsx` SSR, htmx partials. No SPA, no React,
  no client-side bundler (rationale: ARCH.md §17).
- D1 (SQLite) + **Drizzle ORM**: schema lives in `src/db/schema.ts`; `drizzle-kit generate`
  emits plain SQL into `migrations/`; **wrangler** applies them (one migration runner).
  FTS5 table + sync triggers are a hand-written custom migration
  (`drizzle-kit generate --custom`) — Drizzle's DSL can't express them.
- R2 for cover art. Metadata providers behind `src/metadata/provider.ts`:
  Open Library + Google Books (books, both keyless-capable), BoardGameGeek XML API2 (board
  games — no barcode lookup, name search only, needs `BGG_TOKEN` — BGG went registration-only in 2025), Discogs (vinyl, **has** barcode search,
  needs `DISCOGS_TOKEN`).
- Styling is the hand-written design system in `public/app.css` — no CSS framework. The
  visual identity is "the manuscript ledger" (ARCH.md §16 #16), grounded in Nalanda's
  Pala-era scriptorium: palm-leaf buff paper, lampblack ink, indigo working accent,
  vermilion rubrication reserved for circulation/danger, turmeric gold for ratings,
  monospace for all data (counts, ISBNs, dates, pills, accession numbers via `accNo()`),
  Eczar (vendored woff2, Devanagari-first face) for page titles and brand only, light +
  dark (lamp-lit) via `prefers-color-scheme`. The brand hangs from its vermilion
  headstroke (śirorekhā) — that rule lives in `.brand-rule` only. Extend with the
  existing tokens/components (`.pill`, `.data-table`, `.props`, `.eyebrow`) — don't add
  frameworks.
- htmx and ZXing-WASM are pinned as devDependencies and copied to `public/vendor/` by
  `scripts/vendor.mjs` (runs on postinstall) — never hotlinked from a CDN, never imported
  into the Worker bundle.
- Tests: Vitest + `@cloudflare/vitest-pool-workers` (runs in real workerd). Since v0.20
  there is no automatic per-test isolated storage: `test/apply-migrations.ts` calls
  `reset()` and re-applies migrations before every test, and outbound `fetch` is stubbed
  by `test/fetch-mock.ts` rather than the removed `fetchMock` (ARCH.md §16 #25). Config is
  a plain Vitest config plus the `cloudflareTest()` plugin — `defineWorkersConfig` is gone.
- Runtime npm deps: `hono`, `drizzle-orm`, `fast-xml-parser` (BGG is XML; Workers has no
  DOMParser). Adding a dependency beyond these needs a strong reason.

## Hard constraints (Cloudflare free tier)
- Free plans only: Workers, D1, R2. Never introduce paid CF features (Images, Queues, paid
  Durable Objects) or any AWS service.
- **10 ms CPU per request**: no server-side image processing; no server-side bulk parsing —
  CSV imports are parsed in the browser and posted as JSON batches; the Export button fetches
  `/export.csv` 250 items a request (`?after=<id>`) and joins the pages in the browser — the
  whole catalog in one request measured past 10 ms (ARCH.md §16 #38). A page also ends at
  1,000 loans, and an import batch closes at 1,000 (§16 #57).
- **D1 calls per Worker invocation — design to 50, the real cap is 1,000** (ARCH.md §16 #37).
  D1's limits page says 50 on the free plan, but measured on this account the runtime allowed
  exactly 1,000 D1 calls per invocation, and a `batch()` counted as **one** call however many
  statements it held. Work handed to `waitUntil` belongs to the page's invocation. Keep 50 as
  the budget — conservative, and possibly what binds elsewhere — but a batch is one call.
  Connections' background work (feed and outbox pulls, push retries) runs through the
  budgeted handle in `src/federation/budget.ts`; tests count queries per page load with it.
- Password hashing is WebCrypto PBKDF2 only (100k iterations — also workerd's cap). Never
  add bcrypt/argon2 packages (pure-JS, blows the CPU budget).
- Workers runtime is not Node: no `fs`/`net`/native modules — fetch, WebCrypto, and Web
  Streams only. No `nodejs_compat` flag.
- Data portability: every user-visible field must round-trip through `/export.csv`. A new
  column isn't done until export (and import mapping) covers it. Reading goals are the exception:
  they're about people, not items; backups carry them (ARCH.md §16 #49).

## Privacy invariants (share links)
- `/share/:token` pages render a **field whitelist** via `toPublicItem()` in
  `src/lib/share.ts` — never add fields there without checking ARCH.md §9.
- **Never** render on share pages: private `notes`, where an item lives (`location`, ARCH.md §16 #51 —
  never published, and never a key of `toPublicItem()` or `toConnectionItem()`), loans/borrowers, the `copies` count,
  a record's condition (`media_condition`, `sleeve_condition`, §16 #55), `added_by`, usernames, reads or their
  dates, whose reads, or links into the authenticated
  app — and nothing per member unless names are switched on (next bullet). (The derived boolean
  `inCollection` — `copies > 0` — *is* whitelisted; it powers the "Not owned" badge. So is
  `readCount`, the household's finishes, only from two on — "Read N times", ARCH.md §16 #41 —
  and, on a shared game's or record's page, `playCount`, the household's plays, never a play's
  date or who logged it, §16 #54. And a shared item's page shows its series name and number —
  public catalogue data, like the publisher — only through `toPublicItem(item, { series })`,
  ARCH.md §16 #52: never the numbers missing from a series or anyone's "next up", and not on
  listings or to connections.)
  `rating` and `review` there are the household summary: the average of everyone's ratings
  and the review written last, with no author (§16 #43). Reading progress appears only when an
  admin turns on `site_settings.progress_on_shares` (off by default), and then only for a book
  being read now — in progress, or finished and being read again (`rereading`) — as the
  latest page anyone reading it recorded; `toPublicItem(item, { progress })` omits the key
  otherwise. Share pages get `noindex`.
- **Names outside the app** (ARCH.md §16 #45) are a member's optional **display name**, never a
  username, and only while an admin has switched them on — two `site_settings` switches. A new
  instance starts with both on (§16 #49: the code's `SITE_DEFAULTS`, used only while there's no
  row); migration 0036 pinned every instance that already had members to what it had, so an upgrade
  never flips one. Tests about names off say so (`upgradedSwitches()` in test/member-helpers.ts).
  `names_on_shares`: a shared book's page adds `reviews` (each member's rating and review, signed
  with their display name or "A member"), still with no reads, no read dates and no "who read it".
  `names_to_connections`: the feed serves one entry per person with `by` (a display name),
  including kind `started`, and an item page adds `reviews`. Resolve names when serving,
  never when recording — `member_activity` rows point at a read, review, page or goal, never a person.
  **With both off, every served byte stays as before**: no `reviews` or `by` key at all, the
  household's `activity_log` stream and ids untouched; tests compare with and without display
  names. Named feed entries go out with ids past `MEMBER_ACTIVITY_BASE`; one stream is valid at a
  time, so named ids fail the removal check once names are off and household ids while they're on.
  A per-person start or finish is recorded only as it happens, dated then — never by a read's dates,
  never backfilled. A rename or removal re-keys that member's entries in its batch
  (`rekeyMemberActivity()`), and a move of a read or review re-keys that one's (`rekeyMoved()`),
  so peers' held copies are withdrawn. Comments, borrow requests and recommendations are
  signed with `outwardName()` — the display name while names go to connections, else "A member",
  never the username. Names other instances send are strings from another instance (below).
- **Reading goals** (ARCH.md §16 #49) never reach a share page. To connections they are per-person
  entries — `goal_set`, `goal_halfway`, `goal_reached`, each `{ by, year, target, count }` and **no
  `item`** — served only while `names_to_connections` *and* `goals_to_connections` are on (the second
  greyed out on Connections while the first is off), and only for a member with a display name: never
  "A member". Their `member_activity` rows point at the goal (`goal_id`), never a person; a milestone
  also keeps the finish that crossed the line (`read_id`, `item_id`), so it goes only to views holding
  that book and goes when that read does, and a set goes to views that can hold books. Recorded only
  as they happen — the goal's own write in `setGoal()`'s batch, or migration 0036's triggers on a
  finish today or yesterday outside an import — never backfilled, and never dated by a read. A changed
  target re-keys the set and withdraws the old milestones; a deleted goal takes its entries; rename,
  removal and the switch re-key them (`rekeyMemberActivity()`, `setGoalsToConnections()`). What counts
  is `goalCountSql()` — a member's finished reads of books ending in the year — and the triggers
  carry it word for word. The goal kinds are the only item-less ones: `parseFeedEntry()` still needs an
  item on every other kind, and 1.3.0's parser (test/fixtures/items-v1.3.0.ts) skips goal entries.
- **Gift lists** (ARCH.md §16 #53) are the one share kind that isn't a shelf: `shares.want_user_id`
  captures one member's **want list as it stands** and nothing else (no shelf, no filters).
  `shareFilters()` carries it as `wantedBy` and `itemMatchesShare(share, item, tags, wanters)`
  checks the item's wanters — the twins must keep agreeing (a test holds every share kind to it).
  They never count towards a shelf's visibility (`shareVisibility()`, `isWholeShelfShare()`).
  Their pages render `toGiftItem()` — title, creators, cover, type, publisher, published, length,
  description, `inCollection` and **purchase links** — built on `toPublicItem()`: no rating,
  review, reviews, read count, progress, tags or details. The title is "A want list", or the
  member's **display name** only while `names_on_shares` is on — never a username.
  Removing a member deletes their wants and their gift lists in `deleteUser()`'s batch.
- **"Wanted"** is a derived boolean — someone's want list holds the item and `copies = 0` — and the
  one public key want lists added: `toPublicItem(item, { wanted })` adds `wanted: true` only when
  asked and only while not owned, and `toConnectionItem(item, { wanted })` passes it to connections
  (shelf cards, item pages, feed entries) the same way — absent otherwise, so every other item's
  bytes are unchanged, and older peers drop the unknown key. Never whose want, never a count. It
  shows wherever "Not owned" does; a peer's `wanted` renders as our own fixed text. A Not owned
  item's share page never claims it was read (share pages have no status to say so).
- **Purchase links** are pasted, never generated, the item's (any member adds or removes one),
  and **public only on gift lists** — never on a shelf's share page or to connections
  (`toConnectionItem()` has no field for them). `checkPurchaseLink()` (`src/lib/links.ts`) takes
  only an absolute http(s) URL without credentials, on every way in (form, import) and again on
  the way out of a gift list; they render with `target="_blank" rel="noopener noreferrer"`,
  so a share token never reaches a shop. Want lists and links round-trip through `/export.csv`
  (`wanted_by`, `purchase_links`), with names as the reads and reviews cells carry them.
- The shelf's **"Read by" filter** (`ReaderFilter` in `src/db/queries.ts`) is never publishable:
  it is deliberately not part of `ItemFilters`, so `shareFilters()`, `itemMatchesShare()` and
  connection views have no room for it, and the publish form carries no field for it. Keep it
  that way — a published "read by ravi" would tell the world who read what.
- A shelf's search box (`ItemFilters.q`) matches `location`, so share links and connection views
  must never capture `q` (`shareFilters()`, `shelfPage()` don't) — a view filtered by "loft" would
  publish where things are kept.
- Share tokens are random 128-bit, **one per published view** (`shares` table — filters, or a
  tag, captured at publish time; `itemMatchesShare()` guards the public item route, and its
  query-side twin `shareFilters()` must stay in step with it; a captured In progress holds a
  re-read too, through `matchesStatus()`/`statusWhere()`, ARCH.md §16 #64).
  Publish/rotate/remove is admin-only; `/shares` (`src/routes/shares.tsx`) is the
  admin-only inventory of everything published. A shelf is only "Shared" when a
  filterless link exposes it entire — `shareVisibility()`, ARCH.md §16 #23. Share pages are memory-cached per isolate for
  1 h (burst shield); every successful mutation clears the handling isolate's cache,
  but rotation can lag up to 1 h on untouched isolates (ARCH.md §16 #19).
- A record's **condition** (ARCH.md §16 #55) — its media and sleeve grades — describes this
  household's copy, like `copies`: it is never published, not on share pages and not to
  connections. It lives in its own columns precisely because `details` is public; never move a
  grade into `details`, and an import drops an off-scale grade rather than keeping it there. Its
  **pressing** (label, catno, country, year, format, tracklist) is public catalogue data in
  `details`; connections get its plain values, not the tracklist. Discogs' API terms want
  "Data provided by Discogs." beside it, linked to the release, plus their not-affiliated notice
  (ARCH.md §16 #63): `discogsLink()` in `src/views/attribution.tsx` decides — a record with a
  `discogs_id` and something Discogs filled, never one typed in by hand — and builds the href from
  a numeric release id only (else discogs.com). Never `nofollow` on it.
  `details`; connections get its plain values, not the tracklist.
- **Money is never published** (ARCH.md §16 #61). What was paid (`purchase_price`, integer minor
  units, with `purchase_currency`) is in no whitelist: never on share pages, never to connections,
  never a key of `toPublicItem()` or `toConnectionItem()`. `toPublicItem()` also strips money keys
  (`MONEY_DETAIL_KEYS` in `src/lib/money.ts` — libib's `price`) from the `details` it publishes; never
  move a price into `details`. Money is never a float: parse with `parseMoney()`, sum in SQL as
  `CAST(sum(…) AS TEXT)`, format with `formatMoney()`, and never add two currencies together.
- `/covers/:key` is intentionally public — keys are random UUIDs; never make them
  enumerable or derived from item data.
- **The service worker never stores a page or an API answer** (ARCH.md §16 #48): only the
  files in `STATIC` in `public/sw.js`, and it leaves `/share/*` entirely alone. Offline scans
  hold a barcode and a time, nothing else, and belong to the account signed in on the device:
  a different account's pages empty the queue, logout empties it, and POST /items refuses a
  held scan's add (`scanOwner`) for anyone else. Bump `VERSION` in sw.js when `STATIC` or its
  behaviour changes.
- Connections see only `toConnectionItem()` fields (`src/federation/items.ts`, built on
  `toPublicItem()`), and only for items inside a connection view. Availability is a derived
  boolean — never a borrower, due date or copies count, nor where the item is kept (`location`); reading history is a count
  (`readCount`, the household's), never the reads, their dates or their readers; the rating
  and review are the household summary, never a member's name — unless `names_to_connections` is
  on, and then only display names (see above). A view's status filters as the shelf does — In
  progress holds a re-read (§16 #64) — and a view filtered to In progress serves only reading still
  going on (`readingInView()`): no finish or goal milestone, and a reader's start and pages only while
  their read is open, though someone else still reading keeps the book in. Triggers on `items` record
  activity only while a connection view exists (migration 0007), dated by when it happened —
  an import's batch brackets itself with `import_in_progress` so old reads aren't news
  (migration 0021, ARCH.md §16 #40).
- **Recommendations** (ARCH.md §16 #58) send `toRecommendedItem()` — built on `toConnectionItem()`: id, stamp,
  a view id, media type, title, creators, published, cover key, and `ids` (only `bgg_id`/`discogs_id` from
  details, whole numbers) — plus the note and an `outwardName()`; never a username, the ISBN or barcode
  columns, or anything toConnectionItem() lacks. Only for an item inside a connection view
  (`recommendableItem()`, checked at send time), and only to a household whose descriptor lists `Recommend`
  in `accepts`: 1.5.0 and older refuse a type they don't know (test/fixtures/*-v1.4.0.ts). A new directed
  type follows the same rule — advertise it in `ACCEPTS`, check `peerAccepts()` before queuing. What the
  receiver does with one (want, dismiss) is never sent back — though a wanted item on a shared shelf shows
  there as any item does. Wanting one copies its cover from their `/covers/`: `storeCover()` keeps raster
  types only and follows no redirect for a peer's URL, and `serveCover()` sends a sandboxing CSP, so no
  cover can run script on this origin.
- Strings from another instance — household names, view names, feed entries, members' names (`by`, `reviews`), comments,
  recommendations (title, creators, the name it's signed with, the note) —
  render only as escaped text. A comment thread is only ever shown to the two households in it. Never put them inside an inline handler such as `onsubmit="confirm('…')"`:
  the browser decodes HTML escapes back into quotes before it runs the script.

## Commands
```
npm run dev                # wrangler dev — local D1 (real SQLite file) + local R2, offline
npm run dev:demo           # same, on :8788 with its own --persist-to state (screenshots)
npm run seed:demo          # fills that demo instance over HTTP; refuses a non-empty one
npm test                   # vitest, runs inside workerd
npm run typecheck          # tsc --noEmit
npm run lint               # eslint-plugin-jsx-a11y (strict) over src/**/*.tsx, + no-restricted-syntax for
                           # hono's `autofocus` and hx-* off forms/buttons/links — no other rules
npm run a11y               # axe-core (WCAG 2.2 A/AA) on every page in Chromium, light + dark,
                           # 1280 + 390 wide, htmx swaps and a keyboard walk; its own wrangler
                           # dev on 127.0.0.1:8817 with temp --persist-to state (never 8787 or
                           # your dev DB), and one on :8819 for the Refresh buttons (placeholder
                           # provider tokens, refreshes answered by the browser, never Discogs or
                           # BGG); `npx playwright install chromium` once (ARCH.md §18)
npm run db:generate        # drizzle-kit generate — schema.ts → migrations/*.sql
npm run db:migrate         # wrangler d1 migrations apply nalanda --local
npm run db:migrate:remote  # same, against production (via wrangler:remote)
npm run wrangler:remote -- <args>  # any wrangler command against production D1: resolves
                           # the real database id (D1_DATABASE_ID, else by name via
                           # `wrangler d1 list`) into a gitignored temp config
npm run deploy             # needs D1_DATABASE_ID in the env (never in the repo — the
                           # database_id in wrangler.jsonc is an all-zero placeholder);
                           # resolves it into a gitignored config, migrates, deploys
npm run backup             # per-table data-only export → backups/remote-<date>/
                           # (D1 cannot dump databases with FTS5 virtual tables;
                           #  schema comes from migrations/ — see backup runbook);
                           # reaches production the same way as wrangler:remote
npm run backup:local       # same, for the local dev database
npm run backfill:remote -- <step>  # covers + descriptions for production, run from this machine
                           # with the app's own src/metadata (Node's native TS): rehearse |
                           # export | enrich | upload | apply | status — rehearse first;
                           # apply wants a backup < 12 h old (runbooks/metadata-backfill.md)
npm run vendor             # re-copy vendored assets after bumping htmx/zxing/font versions
npm run federation:keygen  # Ed25519 identity for connections → FEDERATION_PRIVATE_KEY
                           # (printed once, never written to disk)
```

## Layout
```
src/index.ts       Hono app entry; route order matters: public (share, covers, auth) first,
                   then requireAuth, then protected routes. Origin-check CSRF on mutations.
src/routes/        pages + htmx partials + /api/lookup, /api/import + share.tsx (public
                   share pages) and shares.tsx (admin share management — don't confuse)
src/views/         hono/jsx layout + components (page() helper wraps Layout + doctype)
src/db/            schema.ts (Drizzle) + queries.ts — the ONLY code touching D1
src/metadata/      provider.ts + index.ts (chain/merge) + openlibrary, googlebooks, bgg,
                   discogs, itunes, musicbrainz — nothing else calls external APIs
src/lib/           auth.ts (pbkdf2, signed cookie), share.ts (public whitelist), csv.ts
                   (export + libib mapping, whose reads an import brings), covers.ts (only R2
                   code), reads.ts (each read: how reads decide status, the legacy mapping, the
                   export cell, Goodreads), reviews.ts (each member's review: the household
                   summary, the export's reviews cell), loans.ts (the export's loans cell),
                   names.ts (display names, and names peers send), plays.ts (the household's play
                   log for games and records: which types take plays, the export's plays cell —
                   ARCH.md §16 #54), series.ts (series names and numbers, the gaps, each member's next up;
                   its queries are in db/queries.ts, its pages in routes/series.tsx, ARCH.md §16 #52),
                   condition.ts (a record's grades and their fixed scale), pressing.ts (what an add
                   and "Refresh from Discogs" may write into a record's details, and reading it back),
                   goals.ts (a reading goal's pace and limits; what counts is goalCountSql in queries.ts),
                   links.ts (purchase links: the http(s) check, the export's want and link cells — §16 #53),
                   dates.ts (how every page writes a date: 2026-09-28, and 2026-09-28 18:28 with a time —
                   display only; public/scan-review.js writes a scan's time the same way),
                   yearreview.ts (the Year in review page's shapes and arithmetic; its one batch is
                   yearInReview() in queries.ts, its page routes/yearreview.tsx — ARCH.md §16 #59)
                   games.ts (a board game's weight bands, the play-tonight filters, and what "Refresh
                   from BGG" may fill; the filtering SQL is gamesForTonight in queries.ts, the page
                   routes/play.tsx, ARCH.md §16 #60),
                   money.ts (purchase prices: minor units, parsing, exact formatting, currency codes —
                   ARCH.md §16 #61)
src/federation/    connections between instances (docs/proposals/connections.md): keys,
                   RFC 9421 signing profile, peer HTTP, messages, item whitelist (items.ts),
                   feed pulls (feed.ts), receiving comments, borrowing and recommendations
                   (comments.ts, borrowing.ts, recommendations.ts, dispatched by directed.ts),
                   the outbox (outbox.ts), public routes. Its D1 queries live in
                   src/db/federation.ts; admin pages in routes/connections, Feed in routes/feed,
                   comments in routes/comments, recommendations in routes/recommendations,
                   shelves/requests/Borrowed and the Loans-page section in routes/borrowing,
                   in-app notifications in routes/notifications (recorded in src/db/federation.ts)
public/            app.css, scanner.js, import.js, app.js, covers.js (swaps a cover that fails to
                   load for its media-icon box; app and share pages) + vendor/ (htmx, zxing, eczar fonts)
                   + the installed app (ARCH.md §16 #48): manifest.webmanifest, icons/, sw.js (keeps
                   only static files — never a page or API answer, never touches /share), offline.html
                   (static scan-only page), scan-queue.js (the device's IndexedDB queue of offline
                   scans: barcode + time only) and scan-review.js (the Add page's review list)
                   + bgg/ (BGG's "Powered by BGG" logos, committed unmodified — its API terms
                   require them beside its data; src/views/attribution.tsx, ARCH.md §16 #44 —
                   Discogs' credit, text only, lives there too, §16 #63)
migrations/        append-only: drizzle-generated + custom SQL (FTS5/triggers)
test/              auth, csv/libib mapping, barcode routing, share whitelist, FTS smoke;
                   apply-migrations.ts resets + re-migrates D1 before EVERY test and fails
                   any test that logs an error it didn't capture and check (console.ts),
                   and fetch-mock.ts stubs outbound fetch (see §16 #25); public/ is bound
                   as ASSETS for tests only, to read static files as served (§16 #48)
scripts/           vendor.mjs (postinstall), deploy.mjs (D1_DATABASE_ID → temp config),
                   backup.mjs + backup-dir.mjs (a same-day backup never overwrites),
                   wrangler-remote.mjs + remote-config.mjs (real db id → temp config),
                   seed-demo.mjs, hash-password.mjs, federation-keygen.mjs,
                   backfill-remote.mjs + ts-resolve.mjs (runs src/metadata under Node),
                   a11y.mjs (the runtime accessibility audit; eslint.config.mjs is the static one)
runbooks/          operational guides: deploy, updating (for self-hosters), backup/restore, accounts,
                   connections, libib import, goodreads import, metadata backfill, troubleshooting —
                   update when ops procedures change
.github/           CI (typecheck + lint + test, and the a11y audit as its own job; no secrets,
                   never pull_request_target), release (on a vX.Y.Z tag: publishes
                   changelog/vX.Y.Z.md; never deploys),
                   dependabot (minor/patch grouped, majors alone), CODEOWNERS
CHANGELOG.md       the release index: one line per release, newest first (ARCH.md §16 #42)
changelog/         vX.Y.Z.md per release, each with an Upgrading section; unreleased.md for PRs
docs/screenshots/  README imagery, captured from seeded demo data — never real catalog data
```

## Conventions
- **Commit after every completed feature or architectural unit** — conventional messages
  (`feat:`, `fix:`, `docs:`, `chore:`, `test:`); never batch unrelated changes into one
  commit. Push only when asked.
- **Releases** (ARCH.md §16 #42) are SemVer. A release commit bumps the version with
  `npm version X.Y.Z --no-git-tag-version`, updates `src/version.ts` to match (a test checks),
  renames `changelog/unreleased.md` to `changelog/vX.Y.Z.md` with its heading
  (`## [X.Y.Z] - <date>`) and a one-sentence summary, creates a fresh `changelog/unreleased.md`,
  and adds the version's line to the CHANGELOG.md index. Its **Upgrading** block says:
  migrations and whether to back up, new secrets, compatibility with connections on older
  versions. PRs add their entries to `changelog/unreleased.md`. After it merges, tag main
  `vX.Y.Z`; the release workflow publishes `changelog/vX.Y.Z.md` (only for tags on main; v1.0.0,
  which predates the workflow, was published by hand). A migration that changes data, a new
  secret, or anything needing a manual step must be in Upgrading.
- Handlers render a full page normally, a partial when the `HX-Request` header is present —
  one handler, two renders.
- Accessibility (ARCH.md §18): WCAG 2.2 AA in both themes. `hx-*` only on forms, buttons and links,
  every field labelled, errors `role="alert"` (+ `invalid()` on their fields), colour never the only
  signal; a new page or htmx swap joins `scripts/a11y.mjs`, and `npm run lint` + `npm run a11y` pass.
- Mutations are POSTs; CSRF = `SameSite=Lax` session cookie + Origin-check middleware.
- A write and whatever depends on it are **one batch**: a change and the message it queues for a
  connection, the notification it records, its replay marker, an item and its tags (ARCH.md §16 #39).
  As separate calls, a failure between them leaves half a change that the path's own idempotency
  check then treats as done. Nothing after the batch may be able to fail the request.
  Cookies set `Secure` only on https so local dev login works.
- Auth model (ARCH.md §8): admin creates member accounts with one-time temp passwords
  (`must_change_password`); roles are just `admin`/`member` — no permission matrix.
  User ids are reused (no AUTOINCREMENT), so a session names the id **and** `users.session_key`
  (random, set in the insert, never changed — ARCH.md §16 #56). Every path that
  inserts a user sets a key; anything else that remembers a person across time (an HMAC
  stamp, a cache) binds `accountIdentity()`, never the bare id.
- Never hand-edit drizzle-generated migrations; hand-written SQL goes in `--custom`
  migrations. Migrations are append-only — never edit one that has been applied anywhere.
- Barcode routing lives in `src/metadata/index.ts`: EAN-13 starting `978`/`979` → book
  providers (Open Library + Google Books merged); any other EAN/UPC → Discogs.
- Tags are normalized lowercase at write time; uniqueness is by exact string.
- Reading state lives in `reads`, one row per read (ARCH.md §16 #41), each with its reader
  (`reader_id`; NULL = a member removed since — §16 #43). `items.status`, `began_on`,
  `completed_on`, `read_count`, `rereading` and `progress_page` are the **household's** summary
  of everyone's reads: write reads and `refreshReadState()` in one batch, never those columns
  directly. Completed once anyone has finished it; a re-read — or anyone's read of a book
  someone finished — keeps it Completed (`rereading` marks it). Every Status filter — the shelf,
  share links, connection views — lists a re-read under In progress **and** Completed
  (`matchesStatus()` in src/lib/reads.ts, `statusWhere()` its SQL twin, ARCH.md §16 #64; never
  compare `items.status` to a filter by hand), and its status pill says "Re-reading". Each
  person has at most one open read of an item; "Read again", Finish, Stop and Record act on the
  signed-in person's own reads, and the edit form's status
  and dates are theirs. Pages belong to their read's reader (`reading_progress.added_by`
  follows a moved read). A finished book takes no page from you until you "Read again".
- Ratings and reviews live in `reviews`, one per member per item (§16 #43). `items.rating`
  (the average, rounded to 1–10) and `items.review` (the one written last, by `reviewed_at`)
  are their summary: write reviews and `refreshReviewState()` in one batch, never those
  columns directly. `reviewed_at` moves only when the text really changes, so a rating
  changed alone never makes an old review the household's latest; a write that can remove a
  review also carries `redateReviewActivity()`, so an older review showing again isn't news.
  Only an admin's import keeps the names a file gives reads and reviews; a member's is theirs.
- Members change their own reads, pages and review; admins anyone's, and only admins move
  one to another member. Check it in the route (403 with a reason) *and* in the statement
  that writes (the `Actor` guards in `src/db/queries.ts`). No permission matrix beyond this.
- `copies = 0` = "in the catalog, not in the physical collection" (reading-log entries,
  e.g. Goodreads imports). Not lendable; badged "Not owned" everywhere incl. share pages
  (ARCH.md §16 #13). The Holding toggle spans **only 0 and 1** — an item held in 2+ copies
  renders a plain count, and the route refuses to zero it, because `copies` round-trips
  through `/export.csv` (ARCH.md §16 #27).

## Ops guardrails
- Develop against local D1. `--remote` is for deploy, remote migrate, backup, and
  `backfill:remote` only.
- Any destructive remote operation (dropping data, hand-run `wrangler d1 execute --remote`)
  requires a fresh `npm run backup` first.
- Secrets (`SESSION_SECRET`, `DISCOGS_TOKEN`, `BGG_TOKEN`, optional `GOOGLE_BOOKS_KEY`, optional
  `HOME_SHARE_TOKEN` — points logged-out `/` at a share page, ARCH.md §16 #21) via
  `wrangler secret put` — never in code, `wrangler.jsonc`, or git. Local values go in
  `.dev.vars` (gitignored; see `.dev.vars.example`).
- **`FEDERATION_PRIVATE_KEY`** is this instance's identity to its connections: a runtime
  secret, never in git or D1, and so not in backups — losing it means reconnecting with every
  household. Unset means connections are disabled entirely and every connections route 404s.
- **No Cloudflare resource ids in the repo** (ARCH.md §16 #24). `database_id` stays the
  all-zero placeholder; deploys supply `D1_DATABASE_ID` from the environment. Don't
  "helpfully" fill it in — and note miniflare keys local D1 state by that value, so
  editing it orphans the local database (§16 #20).
- Keep this file and ARCH.md current as commands and decisions evolve.
