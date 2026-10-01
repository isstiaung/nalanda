# §16 #84 — Item history: triggers record each change to an item's own fields with who made it; admins read it on the item page; 90 days

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #84`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A household of several people edits the same catalog; when a title, a shelf or a cover changes,
nobody could say who or when. **The owner decided** on an admin-only History on the item page:
who changed which of the item's own fields and when, from the existing update paths, kept 90
days — not reads, reviews or plays, which already show who did them.

**What was decided:**
- **Triggers, not call sites.** One `AFTER UPDATE OF <the item's own columns> ON items` trigger
  (migration 0050, hand-written) writes an `item_history` row per changed column — the value
  before and after, kept to 200 characters — so every path that updates an item is covered by
  construction: the edit form, the Holding toggle, bulk edit, a cover, Refresh from BGG or
  Discogs, a merging import, a script. The tracked columns are the item's own: title, creators,
  publisher, published, description, length, ISBNs, type, shelf, copies, location, notes,
  language, original title, cover, formats, series and number, price and currency, grades,
  details. **Never the household's reading summary** (status, dates, read count, re-reading,
  rating, review): those are written by `refreshReadState()`/`refreshReviewState()` from reads
  and reviews, which carry their people already (#41, #43).
- **Who, by a marker in the batch.** A trigger can't know the member, so every item write goes
  out as a batch that sets an `acting` row first and deletes it last (`asWriter()` in
  `src/db/queries.ts` — the `import_in_progress` pattern, #40): a batch is one transaction, so the
  row is never seen by another request. The marker carries the member's id **and session key**
  (#56), copied into the row; the page names the member only while the account's key still
  matches, else "a former member" — a newcomer given a reused id inherits nothing. A write with
  no `Writer` (a script, a trigger's own work) records nobody.
- **Readable, not raw.** The shelf and the series are written by name; the cover as "a cover" or
  nothing (keys are random and the old object is gone); a whole series number without ".0".
- **Admins only, on the item page**, newest first, at most 200 entries, in a `<details>` under
  Circulation. Its purge and read ride in the reading log's batch (`itemHistoryStatements()`),
  so an admin's item page makes the calls a member's does and writes nothing; a member's page has
  no section. **90 days** (`HISTORY_DAYS`): every item write's batch ends with one indexed
  `DELETE … WHERE at < …` (`idx_item_history_at`), so retention holds whether or not anyone opens a
  page and no GET scans the table (review on #123); an item's rows go with it (cascade), and a
  restore from the trash starts fresh under its new id.
- **Inside the app only.** History reaches no share page or connection — neither whitelist has a
  key for it — and the backup lists `item_history` (and the empty-between-batches `acting`).

**What it rules out:** per-call-site logging (a path would be missed); recording creation (the
item's `added_by` and `added_at` say that); keeping values whole (a 10 KB description twice per
edit, for a look-up nobody makes); history of reads, reviews, plays, tags or loans; undo — the
page shows what was, it doesn't restore it.

`test/item-history.spec.ts` holds it: one row per changed field with before and after from a
plain update, nobody named without a writer, the same value again recording nothing, the marker
gone after the batch; the writer named, the shelf and series by name, the cover as a cover, a
long value cut, the reading summary never recorded; every path — toggle, edit form, bulk edit,
cover — with its writer; the page for admins only, newest first, the member named, no call added;
"a former member" after removal and for a newcomer with the reused id; the purge at 90 days and
the cascade on delete.
