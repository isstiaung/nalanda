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
  games — no barcode lookup, name search only), Discogs (vinyl, **has** barcode search,
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
- Tests: Vitest + `@cloudflare/vitest-pool-workers` (runs in real workerd; migrations are
  applied to a fresh D1 in `test/apply-migrations.ts`).
- Runtime npm deps: `hono`, `drizzle-orm`, `fast-xml-parser` (BGG is XML; Workers has no
  DOMParser). Adding a dependency beyond these needs a strong reason.

## Hard constraints (Cloudflare free tier)
- Free plans only: Workers, D1, R2. Never introduce paid CF features (Images, Queues, paid
  Durable Objects) or any AWS service.
- **10 ms CPU per request**: no server-side image processing; no server-side bulk parsing —
  CSV imports are parsed in the browser and posted as JSON batches; CSV export streams.
- Password hashing is WebCrypto PBKDF2 only (100k iterations — also workerd's cap). Never
  add bcrypt/argon2 packages (pure-JS, blows the CPU budget).
- Workers runtime is not Node: no `fs`/`net`/native modules — fetch, WebCrypto, and Web
  Streams only. No `nodejs_compat` flag.
- Data portability: every user-visible field must round-trip through `/export.csv`. A new
  column isn't done until export (and import mapping) covers it.

## Privacy invariants (share links)
- `/share/:token` pages render a **field whitelist** via `toPublicItem()` in
  `src/lib/share.ts` — never add fields there without checking ARCH.md §9.
- **Never** render on share pages: private `notes`, loans/borrowers, the `copies` count,
  `added_by`, usernames, or links into the authenticated app. (The derived boolean
  `inCollection` — `copies > 0` — *is* whitelisted; it powers the "Not owned" badge.)
  Share pages get `noindex`.
- Share tokens are random 128-bit, **one per published view** (`shares` table — filters
  captured at publish time; `itemMatchesShare()` guards the public item route).
  Publish/rotate/remove is admin-only. Share pages are memory-cached per isolate for
  1 h (burst shield); every successful mutation clears the handling isolate's cache,
  but rotation can lag up to 1 h on untouched isolates (ARCH.md §16 #19).
- `/covers/:key` is intentionally public — keys are random UUIDs; never make them
  enumerable or derived from item data.

## Commands
```
npm run dev                # wrangler dev — local D1 (real SQLite file) + local R2, offline
npm test                   # vitest, runs inside workerd
npm run db:generate        # drizzle-kit generate — schema.ts → migrations/*.sql
npm run db:migrate         # wrangler d1 migrations apply nalanda --local
npm run db:migrate:remote  # same, against production
npm run deploy             # remote migrations, then wrangler deploy
npm run backup             # per-table data-only export → backups/remote-<date>/
                           # (D1 cannot dump databases with FTS5 virtual tables;
                           #  schema comes from migrations/ — see backup runbook)
npm run backup:local       # same, for the local dev database
npm run vendor             # re-copy vendored assets after bumping htmx/zxing/font versions
```

## Layout
```
src/index.ts       Hono app entry; route order matters: public (share, covers, auth) first,
                   then requireAuth, then protected routes. Origin-check CSRF on mutations.
src/routes/        pages + htmx partials + /api/lookup, /api/import + share.tsx (public)
src/views/         hono/jsx layout + components (page() helper wraps Layout + doctype)
src/db/            schema.ts (Drizzle) + queries.ts — the ONLY code touching D1
src/metadata/      provider.ts + index.ts (chain/merge) + openlibrary, googlebooks, bgg,
                   discogs — nothing outside this dir calls external APIs
src/lib/           auth.ts (pbkdf2, signed cookie), share.ts (public whitelist), csv.ts
                   (export + libib mapping), covers.ts (only R2 code)
public/            app.css, scanner.js, import.js, app.js + vendor/ (htmx, zxing, eczar fonts)
migrations/        append-only: drizzle-generated + custom SQL (FTS5/triggers)
test/              auth, csv/libib mapping, barcode routing, share whitelist, FTS smoke
runbooks/          operational guides: deploy, backup/restore, accounts, libib import,
                   goodreads import, troubleshooting — update when ops procedures change
.github/           CI (typecheck + test; no secrets, never pull_request_target) + dependabot
docs/screenshots/  README imagery, captured from seeded demo data — never real catalog data
```

## Conventions
- **Commit after every completed feature or architectural unit** — conventional messages
  (`feat:`, `fix:`, `docs:`, `chore:`, `test:`); never batch unrelated changes into one
  commit. Push only when asked.
- Handlers render a full page normally, a partial when the `HX-Request` header is present —
  one handler, two renders.
- Mutations are POSTs; CSRF = `SameSite=Lax` session cookie + Origin-check middleware.
  Cookies set `Secure` only on https so local dev login works.
- Auth model (ARCH.md §8): admin creates member accounts with one-time temp passwords
  (`must_change_password`); roles are just `admin`/`member` — no permission matrix.
- Never hand-edit drizzle-generated migrations; hand-written SQL goes in `--custom`
  migrations. Migrations are append-only — never edit one that has been applied anywhere.
- Barcode routing lives in `src/metadata/index.ts`: EAN-13 starting `978`/`979` → book
  providers (Open Library + Google Books merged); any other EAN/UPC → Discogs.
- Tags are normalized lowercase at write time; uniqueness is by exact string.
- `copies = 0` = "in the catalog, not in the physical collection" (reading-log entries,
  e.g. Goodreads imports). Not lendable; badged "Not owned" everywhere incl. share pages
  (ARCH.md §16 #13).

## Ops guardrails
- Develop against local D1. `--remote` is for deploy, remote migrate, and backup only.
- Any destructive remote operation (dropping data, hand-run `wrangler d1 execute --remote`)
  requires a fresh `npm run backup` first.
- Secrets (`SESSION_SECRET`, `DISCOGS_TOKEN`, optional `GOOGLE_BOOKS_KEY`, optional
  `HOME_SHARE_TOKEN` — points logged-out `/` at a share page, ARCH.md §16 #21) via
  `wrangler secret put` — never in code, `wrangler.jsonc`, or git. Local values go in
  `.dev.vars` (gitignored; see `.dev.vars.example`).
- Keep this file and ARCH.md current as commands and decisions evolve.
