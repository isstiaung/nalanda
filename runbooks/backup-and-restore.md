# Runbook: Backup & restore

The database is the source of truth. Cover images are re-fetchable (Cover backfill on
`/import`), so backing up D1 is what matters.

## Routine backup

```sh
npm run backup          # production → backups/remote-<date>/<table>.sql
npm run backup:local    # local dev  → backups/local-<date>/<table>.sql
```

A second backup on the same day goes to `remote-<date>-2`, then `-3`, and so on. It never writes over
the first, which is usually the one taken before a deploy: the one you'd restore.

A production backup needs the database's real id, which this repo doesn't carry —
`wrangler.jsonc` holds a placeholder. The script uses `D1_DATABASE_ID` when it's set and
otherwise looks the id up by name with `wrangler d1 list`, so being logged in to wrangler
(`npx wrangler login`) is enough. It exports through a temporary, gitignored copy of the
config and deletes it afterwards. Every other command aimed at production goes the same
way: migrations with `npm run db:migrate:remote`, anything else with
`npm run wrangler:remote -- <wrangler arguments>`, as in the restore steps below.

Each table's export makes the production database briefly unavailable, so the script asks
once before it starts. A page someone opens in those few seconds fails with an error. On
2026-09-28 a visitor's request to `/` got a 500 during a backup. So take backups when nobody is
using Nalanda: it's harmless otherwise, and the next request works. D1's export API fails transiently now and then
(`createMultipartUpload: internal error`); a table that fails is tried twice more, and if it
still fails the script stops and says which table — run it again a little later. A backup that
stopped partway leaves an incomplete folder under today's name: delete it before you run the backup
again, so the new one takes its place instead of landing beside it as `-2`.

**Why per-table files instead of one dump:** D1 refuses to export any database that
contains virtual tables — and our FTS5 search index is one. So backups are data-only
INSERT files for the real tables, in a foreign-key-safe order — the list, and the order,
live in `TABLES` in `scripts/backup.mjs`, and the script prints the restore order when it
finishes. The schema is never backed up because it lives in `migrations/`, and the search
index rebuilds itself from triggers during restore.

Left out on purpose: `login_attempts` (login throttling, stale within minutes),
`federation_seen` and `connection_push_counts` (replay and rate bookkeeping, stale within a
day), `import_in_progress` (holds a row only inside an import's own batch, so it's always
empty), and `d1_migrations` (recreated when migrations are applied). The federation private key
isn't in the database at all — it's a secret, so keep your own copy of it.
This procedure is rehearsed: a 315-item backup restored with every row present and the
FTS index rebuilt to match.

- Run one before anything risky (uncertain migrations, bulk imports, manual SQL).
- Keep an off-machine copy occasionally — `backups/` is gitignored on purpose.
- A second, app-agnostic layer: log in → `/import` → *Export everything as CSV*. It imports
  back faithfully: `/import` recognizes its own export and restores every column — type,
  identifiers, dates, every read (the `reads` column), rating, tags, copies, every loan (the
  `loans` column), details — into the shelf you pick on the form. It doesn't recreate shelves (a
  whole-catalog export lands on one shelf), doesn't restore the pages of reading progress, and
  brings loans to connected households back as ordinary loans, unlinked from the household, so
  the per-table backup above is still the full restore.

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
npm run db:migrate:remote

# 2. data, in FK-safe order — the order `npm run backup` prints, TABLES in scripts/backup.mjs
#    (the files set defer_foreign_keys themselves; a table with no rows is an empty file)
for t in users acting api_tokens libraries shares saved_views site_settings series items editions \
        reads reading_progress reviews plays reading_goals wants purchase_links tags item_tags loans \
        borrows item_history federation_settings connection_invites connections connection_views \
        activity_log member_activity feed_subscriptions remote_activities comments outbox \
        borrow_requests connection_loans borrowed_items recommendations notifications quotes trash; do
  npm run wrangler:remote -- d1 execute nalanda --remote --file=backups/remote-<date>/$t.sql
done
```

**A backup older than a data migration** restores at its own level. One taken before 0023,
which turned each book's status and dates into reads (ARCH.md §16 #41), has no `reads.sql`.
Restored into the latest schema, it would give Completed books no reads. So:

1. Apply the migrations up to the one it was taken at (`d1_migrations` of the time).
2. Restore it, skipping tables that didn't exist yet.
3. Apply the rest, so the data migrations run over it.

This is the order the 0023 rehearsal used on the backup of 2026-09-28, and the 0025 rehearsal
too (ARCH.md §16 #43): a backup from before 1.3.0 has no `reviews.sql`, and its reads say nobody's
name, so it restores at 0023 and 0024–0025 then credit its history to the first admin. One
from before 0029 restores at 0027, and 0028–0029 then give each account its own session key
(ARCH.md §16 #56); rehearsed on the backup of 2026-09-29. Restored into the latest schema
instead, its accounts have no key: each gets one at its next password login, and until then
no cookie signs it in.

A backup from before series (the series migration, ARCH.md §16 #52) simply has no `series.sql`: skip it.
That migration changes no data, so such a backup restores straight into the latest schema, every
item in no series.

**A backup from before reading goals (before migration 0036) restores at its own level too, then
the rest** — a 1.4.0 backup at 0029, then 0030–0036 (ARCH.md §16 #49). 0036 writes down the sharing
switches an instance with members was running on — names off, goals off — and a new instance starts
with them on. Migrated straight to the latest on an empty database, 0036 finds no members, writes nothing, and a backup whose `site_settings.sql` is
empty (it never saved a switch) comes back with names and goals switched on — publishing names that
were off. Restored at its own level and then migrated, it keeps what it had.

The search index repopulates automatically as the items insert (trigger-driven). Cover
keys ride along in the data: if the R2 bucket is intact, images work immediately; if the
bucket was lost, clear and re-fetch:

```sh
npm run wrangler:remote -- d1 execute nalanda --remote --command "UPDATE items SET cover_key = NULL"
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
