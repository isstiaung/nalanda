# CLAUDE.md

## Project
Self-hosted, libib-style library manager for a household: catalog **books, board games, and
vinyl records**, add by barcode scan (books/vinyl) or name search (board games via BGG),
auto-fill metadata + covers, tags, loans, public read-only share links, CSV import/export.
Multi-user (admin + family members). **$0/month hosting is a hard requirement.**

[ARCH.md](ARCH.md) is the source of truth for architecture decisions — read it before
structural changes, update it (incl. §16 decision log) when a decision changes.

**Status (2026-07-03): design phase — docs only, no code yet.** Once ARCH.md is approved,
scaffold exactly what it describes.

## Stack (settled — don't re-litigate without updating ARCH.md)
- TypeScript on Cloudflare Workers. Hono + `hono/jsx` SSR, htmx partials. No SPA, no React,
  no client-side bundler (rationale: ARCH.md §17).
- D1 (SQLite) + **Drizzle ORM**: schema lives in `src/db/schema.ts`; `drizzle-kit generate`
  emits plain SQL into `migrations/`; **wrangler** applies them (one migration runner).
  FTS5 table + sync triggers are a hand-written custom migration
  (`drizzle-kit generate --custom`) — Drizzle's DSL can't express them.
- R2 for cover art. Metadata providers behind `src/metadata/provider.ts`:
  Open Library + Google Books (books), BoardGameGeek XML API2 (board games, no barcode
  lookup — name search only), Discogs (vinyl, **has** barcode search).
- Pico.css + `public/app.css`. htmx and ZXing-WASM are vendored files in `public/`, not npm
  imports.
- Tests: Vitest + `@cloudflare/vitest-pool-workers`.
- Runtime npm deps: `hono`, `drizzle-orm`, `fast-xml-parser` (BGG is XML; Workers has no
  DOMParser). Adding a dependency beyond these needs a strong reason.

## Hard constraints (Cloudflare free tier)
- Free plans only: Workers, D1, R2. Never introduce paid CF features (Images, Queues, paid
  Durable Objects) or any AWS service.
- **10 ms CPU per request**: no server-side image processing; no server-side bulk parsing —
  CSV imports are parsed in the browser and posted as JSON batches; CSV export streams.
- Password hashing is WebCrypto PBKDF2 only. Never add bcrypt/argon2 packages (pure-JS,
  blows the CPU budget).
- Workers runtime is not Node: no `fs`/`net`/native modules — fetch, WebCrypto, and Web
  Streams only.
- Data portability: every user-visible field must round-trip through `/export.csv`. A new
  column isn't done until export (and import mapping) covers it.

## Privacy invariants (share links)
- `/share/:token` pages render a **field whitelist** (title, creators, cover,
  publisher/label, published, description, details, tags, rating, review) via the views in
  `src/views/share/` — never add fields there without checking ARCH.md §9.
- **Never** render on share pages: private `notes`, loans/borrowers, `copies`, `added_by`,
  usernames, or links into the authenticated app. Share pages get `noindex`.
- Share tokens are random 128-bit; publish/rotate/disable is admin-only.
- `/covers/:key` is intentionally public — keys are random UUIDs; never make them
  enumerable or derived from item data.

## Commands
```
npm run dev                # wrangler dev — local D1 (real SQLite file) + local R2, offline
npm test                   # vitest, runs inside workerd
npm run db:generate        # drizzle-kit generate — schema.ts → migrations/*.sql
npm run db:migrate         # wrangler d1 migrations apply personal-library --local
npm run db:migrate:remote  # same, against production
npm run deploy             # remote migrations, then wrangler deploy
npm run backup             # wrangler d1 export --remote → backups/<date>.sql
```

## Layout
```
src/index.ts       Hono app entry; middleware: session (+ user-exists check), roles,
                   Origin-check CSRF
src/routes/        pages + htmx partials + /api/lookup, /api/import + share.tsx (public)
src/views/         hono/jsx layout + components; share/ = whitelisted public views
src/db/            schema.ts (Drizzle) + query helpers — the ONLY code touching D1
src/metadata/      provider.ts + openlibrary.ts, googlebooks.ts, bgg.ts, discogs.ts
src/lib/           auth.ts (pbkdf2, signed cookie), csv.ts, covers.ts (only R2 code)
public/            static assets (served free via Workers assets)
migrations/        append-only: drizzle-generated + custom SQL (FTS5/triggers)
```

## Conventions
- Handlers render a full page normally, a partial when the `HX-Request` header is present —
  one handler, two renders.
- Mutations are POSTs; CSRF = `SameSite=Lax` session cookie + Origin-check middleware.
- Auth model (ARCH.md §8): admin creates member accounts with one-time temp passwords
  (`must_change_password`); roles are just `admin`/`member` — no permission matrix.
- Never hand-edit drizzle-generated migrations; hand-written SQL goes in `--custom`
  migrations. Migrations are append-only — never edit one that has been applied anywhere.
- New metadata sources implement `src/metadata/provider.ts` and join the chain; nothing
  outside `src/metadata/` calls external APIs. Barcode routing: EAN `978`/`979` → book
  providers; any other EAN/UPC → Discogs.
- D1 stays behind `src/db/`, R2 behind `src/lib/covers.ts` (this is the exit strategy —
  ARCH.md §13).

## Ops guardrails
- Develop against local D1. `--remote` is for deploy, remote migrate, and backup only.
- Any destructive remote operation (dropping data, hand-run `wrangler d1 execute --remote`)
  requires a fresh `npm run backup` first.
- Secrets (`SESSION_SECRET`, `DISCOGS_TOKEN`, optional `GOOGLE_BOOKS_KEY`) via
  `wrangler secret put` — never in code, `wrangler.jsonc`, or git.
- Keep this file and ARCH.md current as commands and decisions evolve.
