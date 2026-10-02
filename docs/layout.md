# Layout

Where everything lives, file by file. [CLAUDE.md](../CLAUDE.md) keeps the rules this map carries (which
code alone may touch D1, R2 and external APIs, route order, append-only migrations); ARCH.md §11 is the
architectural view.

```
src/index.ts       Hono app entry; route order matters: public (share, covers, fonts, auth) first,
                   then requireAuth, then protected routes. Origin-check CSRF on mutations.
src/routes/        pages + htmx partials + /api/lookup, /api/import; share.tsx (public share pages)
                   and shares.tsx (admin share management — don't confuse); api.tsx (the read-only
                   token API, /api/v1/…, ARCH.md §16 #88, mounted before the session middleware — a
                   token, never a cookie); discover.tsx (new from your authors, ARCH.md §16 #78);
                   trash.tsx (what was deleted in the last 30 days, admin-only; the snapshot and
                   restore are trashItems()/restoreFromTrash() in db/queries.ts, ARCH.md §16 #74)
src/views/         hono/jsx layout + components (page() helper wraps Layout + doctype)
src/routes/        pages + htmx partials + /api/lookup, /api/import + discover.tsx (new from your
                   api.tsx is the read-only token API (/api/v1/…, ARCH.md §16 #88), mounted before the session
                   middleware — a token, never a cookie;
                   authors, ARCH.md §16 #78) + share.tsx (public
                   share pages) and shares.tsx (admin share management — don't confuse)
                   + trash.tsx (what was deleted in the last 30 days, admin-only; the snapshot
                   and restore are trashItems()/restoreFromTrash() in db/queries.ts, ARCH.md §16 #74)
src/views/         hono/jsx layout + components (page() helper wraps Layout + doctype; partial() an htmx swap)
                   + i18n.tsx (the request's Translator as a hono/jsx context: useI18n() in any component,
                   Fill for a sentence with elements in it, the label helpers — ARCH.md §16 #93)
src/i18n/          the interface strings (ARCH.md §16 #93): strings.ts the English source, one key per string;
                   hi.ts and ta.ts full translations, `draft: true` until a native reader checks them;
                   index.ts — t(), n(), resolveLocale(), translator(), stringsFor() (the download),
                   parseTranslation() (the import). Pure data and functions: nothing here touches D1 or hono.
                   The download is routes/strings.tsx; the import lives in routes/settings.tsx with
                   public/translations.js reading the file in the browser; the per-request reads are
                   sessionAccount(), householdLocale(), shareWithLocale() in db/queries.ts
src/db/            schema.ts (Drizzle) + queries.ts — the ONLY code touching D1
src/metadata/      provider.ts + index.ts (chain/merge) + openlibrary, googlebooks, bgg,
                   discogs, itunes, musicbrainz — nothing else calls external APIs
src/lib/           auth.ts (pbkdf2, signed cookie), devices.ts (a session's device name from its User-Agent —
                   ARCH.md §16 #98), pairing.ts (signing in from another device: the code's alphabet, reading it
                   back, the digits to match and the three choices — §16 #99; the pages in routes/auth.tsx and
                   routes/account.tsx), share.ts (public whitelist), csv.ts
                   (export + libib, Goodreads, StoryGraph and LibraryThing mappings, whose reads an import brings), covers.ts (with
                   fonts.ts, the only R2 code), fonts.ts (a household's display fonts: the sniffer, the
                   1 KB–2 MB caps, store, delete, serve, the checked face a page's <style> takes — ARCH.md
                   §16 #96; the upload in routes/settings.tsx, the <style> in views/layout.tsx), reads.ts (each read: how reads decide status, the legacy mapping, the
                   export cell, Goodreads), reviews.ts (each member's review: the household
                   summary, the export's reviews cell), loans.ts (the export's loans cell),
                   names.ts (display names, and names peers send), plays.ts (the household's play
                   log for games and records: which types take plays, the export's plays cell —
                   ARCH.md §16 #54), series.ts (series names and numbers, the gaps, each member's next up;
                   its queries are in db/queries.ts, its pages in routes/series.tsx, ARCH.md §16 #52),
                   formats.ts (the forms an item is held in, per kind; "also held as" lines and their
                   CSV cells; what a provider's format words map to — ARCH.md §16 #75),
                   language.ts (every ISO 639-1 language by name, the household default, what a provider's
                   or a file's code means — ARCH.md §16 #76),
                   feeds.ts (a share link's Atom and RSS: the XML, the dates, an entry's HTML — ARCH.md §16 #86;
                   the route is in routes/share.tsx, the queries in db/queries.ts),
                   quotes.ts (a quote's shape and tidying, the `quotes` CSV cell, what the Kindle import posts —
                   ARCH.md §16 #77; its pages are routes/quotes.tsx and views/quotes.tsx, the file's parsing
                   public/kindle.js),
                   search.ts (the search box's operators — author:, title:, tag:, status:, year:, lang:, type: — parsed
                   once and the FTS5 expression; searchItems in db/queries.ts applies them, ARCH.md §16 #80),
                   creators.ts (the people in a creators string — the twin of YEAR_CREATORS in queries.ts — and
                   what each kind calls them; its pages are routes/creators.tsx, the item page's links
                   views/creators.tsx, ARCH.md §16 #72),
                   condition.ts (a record's grades and their fixed scale), pressing.ts (what an add
                   and "Refresh from Discogs" may write into a record's details, and reading it back),
                   goals.ts (a reading goal's pace and limits; what counts is goalCountSql in queries.ts),
                   links.ts (purchase links: the http(s) check, the export's want and link cells — §16 #53),
                   dates.ts (how every page writes a date: 2026-09-28, and 2026-09-28 18:28 with a time —
                   display only; public/scan-review.js writes a scan's time the same way — and today
                   where the device is, from its `tz` cookie: `todayOf(c)` in views/layout.tsx, ARCH.md §16 #69),
                   yearreview.ts (the Year in review page's shapes and arithmetic; its one batch is
                   yearInReview() in queries.ts, its page routes/yearreview.tsx — ARCH.md §16 #59)
                   games.ts (a board game's weight bands, the play-tonight filters, and what "Refresh
                   from BGG" may fill; the filtering SQL is gamesForTonight in queries.ts, the page
                   routes/play.tsx, ARCH.md §16 #60),
                   money.ts (purchase prices: minor units, parsing, exact formatting, currency codes —
                   ARCH.md §16 #61),
                   custom.ts (the household's custom fields: what a value may be by kind, the item form's
                   values, what a share page may show, the export's `custom` cell by name — ARCH.md §16 #95;
                   the panel is in routes/settings.tsx, the queries in db/queries.ts)
src/federation/    connections between instances (docs/proposals/connections.md): keys,
                   RFC 9421 signing profile, peer HTTP, messages, item whitelist (items.ts),
                   feed pulls (feed.ts), receiving comments, borrowing and recommendations
                   (comments.ts, borrowing.ts, recommendations.ts, dispatched by directed.ts),
                   the outbox (outbox.ts), public routes, and the FEDERATION_OFFLINE switch
                   (offline.ts, ARCH.md §16 #92: a restored copy contacts no peer). Its D1 queries live in
                   src/db/federation.ts; admin pages in routes/connections, Feed in routes/feed,
                   comments in routes/comments, recommendations in routes/recommendations,
                   shelves/requests/Borrowed and the Loans-page section in routes/borrowing — Borrowed
                   is every household's page since ARCH.md §16 #82, its people section first,
                   in-app notifications in routes/notifications (recorded in src/db/federation.ts)
public/            app.css, scanner.js, import.js, translations.js (the Members page reads a translation file in the
                   browser and posts it as JSON — ARCH.md §16 #93), qr.js (each share link's QR code, drawn on the Shared links
                   page from the vendored qrcode.js — ARCH.md §16 #85), app.js (also shrinks a chosen cover photo before the form
                   sends it, ARCH.md §16 #73), covers.js (swaps a cover that fails to
                   load for its media-icon box; app and share pages) + vendor/ (htmx, zxing, the Eczar and Tiro Tamil fonts)
                   + the installed app (ARCH.md §16 #48): manifest.webmanifest, icons/, sw.js (keeps
                   only static files — never a page or API answer, never touches /share), offline.html
                   (static scan-only page), scan-queue.js (the device's IndexedDB queue of offline
                   scans: barcode + time only — offline, or with "Keep scanning" on, ARCH.md §16 #94) and
                   scan-review.js (the Add page's review list, and the "Add all" loop that posts
                   held barcodes to POST /api/scans/add twenty a request)
                   + bgg/ (BGG's "Powered by BGG" logos, committed unmodified — its API terms
                   require them beside its data; src/views/attribution.tsx, ARCH.md §16 #44 —
                   Discogs' credit, text only, lives there too, §16 #63)
                   + _headers (Cloudflare serves these files before the Worker runs, so
                   secureHeaders() never sees them: X-Frame-Options and nosniff for every one,
                   Cache-Control left at the asset server's revalidate-always default; never served
                   itself; honoured by wrangler dev and the tests' ASSETS binding alike)
migrations/        append-only: drizzle-generated + custom SQL (FTS5/triggers)
test/              auth, csv/libib mapping, barcode routing, share whitelist, FTS smoke;
                   apply-migrations.ts resets + re-migrates D1 before EVERY test and fails
                   any test that logs an error it didn't capture and check (console.ts),
                   and fetch-mock.ts stubs outbound fetch (see §16 #25); public/ is bound
                   as ASSETS for tests only, to read static files as served (§16 #48)
scripts/           demo-build.mjs + demo-static.mjs (+ its .d.mts, for the test under tsc) (the static demo: a seeded scratch instance crawled into
                   demo/ for GitHub Pages — ARCH.md §16 #89; the pure parts tested), vendor.mjs (postinstall), deploy.mjs (D1_DATABASE_ID → temp config),
                   backup.mjs + backup-dir.mjs (a same-day backup never overwrites),
                   wrangler-remote.mjs + remote-config.mjs (real db id → temp config),
                   seed-demo.mjs, hash-password.mjs, federation-keygen.mjs,
                   backfill-remote.mjs + ts-resolve.mjs (runs src/metadata under Node),
                   a11y.mjs (the runtime accessibility audit; eslint.config.mjs is the static one)
runbooks/          operational guides: deploy, updating (for self-hosters), backup/restore, accounts,
                   connections, the read-only API, the libib, Goodreads, StoryGraph, LibraryThing and Kindle
                   imports, metadata backfill, record covers (a one-off), troubleshooting — update when ops
                   procedures change
.github/           CI (typecheck + lint + test, and the a11y audit as its own job; no secrets,
                   never pull_request_target), release (on a vX.Y.Z tag: publishes
                   changelog/vX.Y.Z.md; never deploys),
                   dependabot (minor/patch grouped, majors alone), CODEOWNERS
CHANGELOG.md       the release index: one line per release, newest first (ARCH.md §16 #42)
changelog/         vX.Y.Z.md per release, each with an Upgrading section; unreleased.md for PRs
docs/              privacy.md, conventions.md, layout.md: the detail behind CLAUDE.md; proposals/;
                   perf/ (the query analysis, ARCH.md §16 #68); adding-a-column.md and
                   adding-a-provider.md, the two contributor guides
docs/features/     what Nalanda does, one page per area (cataloguing, reading, shelves and search,
                   imports and exports, sharing, lending, connections, members and privacy, on your
                   phone), indexed by its README.md and linked from the root README — each page
                   links the runbooks and decisions it rests on; a feature isn't documented until
                   its page says what the code does
docs/decisions/    the decision log, one file per decision, indexed by ARCH.md §16 — cite a
                   decision as "ARCH.md §16 #N", and the index resolves it
docs/screenshots/  README imagery, captured from seeded demo data — never real catalog data
```
