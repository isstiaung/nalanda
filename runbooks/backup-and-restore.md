# Runbook: Backup & restore

The database is the source of truth. Cover images are re-fetchable (Cover backfill on
`/import`), so backing up D1 is what matters.

## Routine backup

```sh
npm run backup          # production → backups/remote-<date>/<table>.sql
npm run backup:local    # local dev  → backups/local-<date>/<table>.sql
```

**Why per-table files instead of one dump:** D1 refuses to export any database that
contains virtual tables — and our FTS5 search index is one. So backups are data-only
INSERT files for the real tables (`users`, `libraries`, `items`, `tags`, `item_tags`,
`loans`, in that FK-safe order). The schema is never backed up because it lives in
`migrations/`, and the search index rebuilds itself from triggers during restore.
This procedure is rehearsed: a 315-item backup restored with every row present and the
FTS index rebuilt to match.

- Run one before anything risky (uncertain migrations, bulk imports, manual SQL).
- Keep an off-machine copy occasionally — `backups/` is gitignored on purpose.
- A second, app-agnostic layer: log in → `/import` → *Export everything as CSV*.

## Restore

### Oops within the last month — D1 Time Travel (production)

D1 keeps point-in-time history; to rewind the production database in place:

```sh
npx wrangler d1 time-travel info nalanda
npx wrangler d1 time-travel restore nalanda --timestamp=2026-07-01T10:00:00Z
```

Take a fresh `npm run backup` first — a restore is itself a change you may want to undo.

### From a backup directory

Restore assumes **empty tables** (a fresh database, or one you've deliberately wiped).

```sh
# 1. schema — includes the FTS index and its sync triggers
npx wrangler d1 migrations apply nalanda --remote

# 2. data, in FK-safe order (the files set defer_foreign_keys themselves)
for t in users libraries shares items tags item_tags loans; do
  npx wrangler d1 execute nalanda --remote --file=backups/remote-<date>/$t.sql
done
```

The search index repopulates automatically as the items insert (trigger-driven). Cover
keys ride along in the data: if the R2 bucket is intact, images work immediately; if the
bucket was lost, clear and re-fetch:

```sh
npx wrangler d1 execute nalanda --remote --command "UPDATE items SET cover_key = NULL"
# then: production /import → Cover backfill
```

### Local dev database

Blow it away and start fresh anytime:

```sh
rm -rf .wrangler/state
npm run db:migrate
```

…or restore a `backups/local-<date>/` backup into it with the same per-table procedure,
using `--local` instead of `--remote`.

## What NOT to do

- Never run `wrangler d1 execute nalanda --remote` with hand-written SQL without a fresh
  backup (CLAUDE.md ops guardrail).
- Don't edit applied migration files to "fix" schema drift — write a new migration.
- Don't reach for `wrangler d1 export` without `--table`: it fails on this database
  (FTS5 virtual table) by design.
