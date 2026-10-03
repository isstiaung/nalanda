# §16 #102 — Migrations are additive only: from 0063 on, a migration adds, and never removes or rewrites

**Decided:** 2026-10-04. Cited as `ARCH.md §16 #102`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A household running Nalanda from a fork (#101) updates by pressing **Sync fork**. Cloudflare then
builds the release and applies its migrations before the new code goes live: unattended, the moment
they sync, and usually with no backup taken, since a backup needs a terminal. A migration that went
wrong would land on other people's live libraries. D1 Time Travel can undo it for seven days, but
only from a terminal. A side agent raised this, and **the owner decided: migrations additive only.**

**What was decided:**
- **From `0063` on, a migration may add:**
  - create tables, indexes, triggers and views;
  - add columns, nullable or with a default;
  - insert rows (seeding, or copying into a new table with `INSERT … SELECT`);
  - drop and re-create an index, a trigger or a view, which hold no data of their own;
  - drop and re-create the full-text index (`*_fts`), a copy of the items' text rebuilt in the same
    migration (`'rebuild'`).
- **It may never remove or rewrite.** No dropping a table or a column, no renaming, no `UPDATE`,
  `DELETE` or `REPLACE` of rows. That includes Drizzle's table rebuild for a changed column type or
  constraint, which drops and renames. A change that seems to need one is made another way:
  - a new nullable column the code fills as rows are written, or derives when it is null;
  - a new table copied into with `INSERT … SELECT`, the old one left in place;
  - a default the code reads.
- **Everything up to `0062`**, released by 1.10.0, is as it was. Those include backfills, a table
  rebuild and deletes, and every instance has applied them already.
- **An exception** would be named in the test with a decision of its own, and called out in that
  release's Upgrading notes, so a household exports first. There are none.
- **Enforced by `test/migrations-additive.spec.ts`.** It checks every statement of every migration
  from `0063` on, skipping a trigger's body, which is code for later, not a change now. A test of the
  rule itself holds what passes and what doesn't, a Drizzle rebuild included. Checked against the old
  migrations with the cutoff lowered, it finds their backfills, rebuild and rename.

**What it rules out:**
- Schema "cleanups": dropping a column no code reads any more costs nothing to leave.
- Fixing data in a migration. A one-off fix for a single instance is a runbook step its owner runs,
  after a backup.

**Tests:** `test/migrations-additive.spec.ts`.
