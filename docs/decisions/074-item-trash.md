# §16 #74 — Deleting an item puts it in the trash for 30 days: a snapshot SQLite builds in the delete's own batch, restored through the import's insert, never a soft delete

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #74`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A delete was a delete: an item, its reads, reviews, pages, plays, loans, wants, links and
tags, and its cover's object, gone at once, with a confirm dialog the only guard. A family
member will do that by mistake exactly once, and the review of 2026-10-01 put a trash with
undo among the small things to fix first. **The owner asked** for it and chose this shape over
a soft delete.

**What was decided:**
- **Not a soft delete.** A `deleted_at` column would have to be honoured by every one of the
  88 places that read items across `queries.ts` and `federation.ts`, the FTS search, the
  shelf counts, and the SQL triggers that count goals and record connection activity — and
  the cost of missing one is a trashed item on a share page or in a connection's feed, the
  privacy rules §9 and #45 guard hardest. A view (`live_items`) would make the sweep
  mechanical but no smaller. So the delete stays a delete, and is as safe as it was.
- **A snapshot in a `trash` table** (migration 0042): one row per deleted item, with its id,
  shelf, type, title, creators and cover key for the listing, and a `payload` JSON holding
  the item's every column and everything that hung off it — tags, series, reads, reviews,
  pages (each with the read it belonged to), plays, wants, links, loans. **SQLite builds the
  JSON** (`json_object`, `json_group_array`) in the same statement that inserts the row, and
  the `DELETE` follows in the same batch (`trashItems()`): nothing is deleted without its
  snapshot, nothing snapshotted stays. The item's columns come from the schema at run time,
  so a column added later is in the snapshot the day it exists, and a test holds the
  snapshot's keys to the table's. No foreign keys: the shelf and the member may be gone by
  the time the row is read, and it must still say what it said.
- **Restore is an import** (`restoreFromTrash()`): the snapshot becomes an `ImportRow` and goes
  through `importItems()`, which already inserts an item with its series, tags, reads,
  reviews, loans, plays, wants and links in one batch — now with its recorded pages too
  (`ImportRow.progress`, each page pointed back at its read by the read's reader, status and
  dates), and with the trash row's `DELETE` in the same batch, so a restore can't happen
  twice. The item gets a **new id** (ids are reused, #56, so the old one may be anyone's);
  `added_at` and the cover key are its own again. A member removed since is nobody on what
  was theirs, and their want is dropped. It is bracketed as an import, so old reads aren't
  news to connections (#40), which see it as newly added. A restore onto a shelf removed
  since fails whole, and the row stays.
- **The cover's object stays in R2** until the row is purged, so a restore has its cover with
  no fetch. Both delete paths — an item's page (any member) and the bulk delete (an admin's,
  #47) — now leave the object alone; `discardTrash()` and `purgeTrash()` delete it.
- **30 days, swept on the way in.** The free tier has no cron (#36's reasoning), so
  `purgeTrash()` runs when the Trash page is opened: rows past `TRASH_DAYS` and their covers
  go, as the login-attempt table prunes itself.
- **The Trash page is an admin's** (`/trash`, in the sidebar's Settings), like deleting in
  bulk and the other pages that undo what members did: it lists what was deleted, by whom
  and when, with **Restore** and **Delete for good**. The item page's confirm and the bulk
  confirmation say an admin can restore from the trash for 30 days.
- **Backups carry the trash; the CSV doesn't.** The backup script exports every table. The
  export is the catalogue as it stands, as before.

**What it rules out:** a soft delete (above); restoring under the old id (a race with a new
item given it, and a stale id in a connection's hands means nothing anyway); a trash for
shelves, tags or members; a member restoring their own deletions (deleting is any member's,
undeleting is an admin's, as bulk deleting is).

`test/trash.spec.ts` holds it: a delete leaves every surface as before and keeps the cover;
the snapshot's keys match the schema and its contents match what the item had; bulk delete
and the series pruning; restore brings back every dependent, the household summary
recomputed, the pages on their read, and refuses a second restore; a removed member is
nobody; a gone shelf fails whole; the page is an admin's, restores, deletes for good, and
purges by age with the covers.
