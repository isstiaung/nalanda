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
  `added_at` and the cover key are its own again. **People are matched by id and key, never
  the id alone** (#56): the snapshot holds every member's id and `session_key` as they were
  (`people`), and a restore hands a read, review, page, play or want back to an id only while
  that id still has that key — a member removed since is nobody on what was theirs and their
  want is dropped, and so is a member given the removed one's id in the meantime, who would
  otherwise inherit a stranger's reading. The trash row names its deleter the same way
  (`deleted_by` with `deleted_by_key`). **Shelves likewise**: shelf ids are reused, so the row
  keeps the shelf's name, and a restore goes to the shelf it was on only while it is still so
  named, else to a shelf of that name, else is refused with the reason and the row stays —
  never silently onto whatever shelf has the id now, which might be a shared one. It is
  bracketed as an import, so old reads aren't news to connections (#40), which see it as
  newly added.
- **The cover's object stays in R2** until the row is purged, so a restore has its cover with
  no fetch. Both delete paths — an item's page (any member) and the bulk delete (an admin's,
  #47) — now leave the object alone; `discardTrash()` and `purgeTrash()` delete it.
- **30 days, swept on every delete and every visit.** The free tier has no cron (#36's
  reasoning), so the purge rides along: `trashItems()`'s batch first deletes rows past
  `TRASH_DAYS` and hands back their cover keys for the route to delete the objects, and the
  Trash page does the same when opened — as the login-attempt table prunes itself. So the
  retention holds whether or not an admin ever opens the page: private notes, locations,
  borrowers and covers are not kept past it.
- **A trashed item's cover stays reachable** at `/covers/:key` for the 30 days, where before
  the object went at once: anyone who held the key — a connected household's page that
  showed it — can still load it. Keys are random UUIDs (#19), so nothing can find one, and
  the cover was public while the item was shared; accepted.
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
