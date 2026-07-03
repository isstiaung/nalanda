# Nalanda 📚

Self-hosted home library manager for **books, board games, and vinyl records** — a
libib-style catalog that runs on Cloudflare's free tier at **$0/month**. Named for the
library of the Nalanda mahāvihāra.

- **Scan to shelf**: point your phone camera at a book or record barcode; ISBNs look up
  books (Open Library + Google Books), other barcodes look up vinyl (Discogs). Board games
  add by name search (BoardGameGeek).
- **Family accounts**: admin + members, no email infrastructure needed.
- **Loans**: track who borrowed what, with due dates and history.
- **Public share links**: publish a read-only shelf at an unguessable URL; private notes
  and loans never appear.
- **Tags, ratings, reviews, full-text search** across the whole collection.
- **Own your data**: lossless libib CSV import, full CSV export, plain-SQLite backups.

Stack: TypeScript · Cloudflare Workers · Hono (server-rendered JSX) + htmx · D1 (SQLite) +
Drizzle · R2 for cover art. One deployable, no client build, three runtime dependencies.
See [ARCH.md](ARCH.md) for the design and the reasoning behind it.

## Local development

```sh
npm install        # also vendors htmx/pico/zxing into public/vendor/
npm run db:migrate # create the local SQLite database
npm run dev        # http://localhost:8787 → /setup creates the admin account
npm test           # vitest, runs inside the real Workers runtime
```

Everything runs offline: local D1 is a real SQLite file, R2 is emulated, and the camera
works on localhost. Local secrets live in `.dev.vars` (copy `.dev.vars.example`).

## Deploying

One-time setup and every-day deploys are covered step by step in
[runbooks/deploy.md](runbooks/deploy.md). The short version:

```sh
wrangler d1 create nalanda            # paste the id into wrangler.jsonc
wrangler r2 bucket create nalanda-covers
wrangler secret put SESSION_SECRET
wrangler secret put DISCOGS_TOKEN     # free — enables vinyl barcode lookup
npm run deploy
```

## Operations

| Runbook | When to use it |
|---|---|
| [deploy.md](runbooks/deploy.md) | First deploy, updates, rollback, custom domain, API tokens |
| [backup-and-restore.md](runbooks/backup-and-restore.md) | Routine backups, restoring after a mistake |
| [accounts-and-access.md](runbooks/accounts-and-access.md) | Family accounts, lost passwords, admin lockout, share links |
| [import-from-libib.md](runbooks/import-from-libib.md) | Migrating your libib collection |
| [troubleshooting.md](runbooks/troubleshooting.md) | Scanner, lookups, deploys, logs |

Working conventions for future development live in [CLAUDE.md](CLAUDE.md).
