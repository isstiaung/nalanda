# Runbook: Backup & restore

The database is the source of truth. Cover images are re-fetchable from the metadata
providers, so backing up D1 is what matters.

## Routine backup

```sh
npm run backup     # → backups/nalanda-<date>.sql (plain SQLite dump, human-readable)
```

- Run it before anything risky (migrations you're unsure about, bulk imports, manual SQL).
- Keep an off-machine copy occasionally (cloud drive, another disk) — `backups/` is
  gitignored on purpose.
- A second, app-agnostic layer: log in → `/import` → *Export everything as CSV*.

## Restore

### Oops within the last month — D1 Time Travel

D1 keeps point-in-time history. To rewind the **production** database in place:

```sh
npx wrangler d1 time-travel info nalanda                  # shows the current bookmark
npx wrangler d1 time-travel restore nalanda --timestamp=2026-07-01T10:00:00Z
```

Take a fresh `npm run backup` first — restore is itself a change you may want to undo.

### From a .sql dump

Safest path — restore into a NEW database and swap:

```sh
npx wrangler d1 create nalanda-restore
npx wrangler d1 execute nalanda-restore --remote --file backups/nalanda-<date>.sql
```

Then put the new `database_id` into `wrangler.jsonc`, `npm run deploy`, and verify. Keep
the old database around until you're sure; delete it later with
`npx wrangler d1 delete nalanda`.

### Covers after a restore

Cover keys in the restored rows still point at the same R2 bucket, so images survive a
database restore untouched. If the bucket itself was lost, items render with a placeholder;
re-add covers by editing an item and pasting a cover URL (the app fetches and stores it).

## Local dev database

Blow it away and start fresh anytime:

```sh
rm -rf .wrangler/state
npm run db:migrate
```

## What NOT to do

- Never run `wrangler d1 execute nalanda --remote` with hand-written SQL without a fresh
  backup (CLAUDE.md ops guardrail).
- Don't edit applied migration files to "fix" schema drift — write a new migration.
