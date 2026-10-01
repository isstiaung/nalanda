# Layout

Where everything lives, file by file. [CLAUDE.md](../CLAUDE.md) keeps the rules this map carries (which
code alone may touch D1, R2 and external APIs, route order, append-only migrations); ARCH.md §11 is the
architectural view.

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
public/            app.css, scanner.js, import.js, app.js (also shrinks a chosen cover photo before the form
                   sends it, ARCH.md §16 #73), covers.js (swaps a cover that fails to
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
docs/              privacy.md, conventions.md, layout.md: the detail behind CLAUDE.md; proposals/;
                   perf/ (the query analysis, ARCH.md §16 #68)
docs/decisions/    the decision log, one file per decision, indexed by ARCH.md §16 — cite a
                   decision as "ARCH.md §16 #N", and the index resolves it
docs/screenshots/  README imagery, captured from seeded demo data — never real catalog data
```
