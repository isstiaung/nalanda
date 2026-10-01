# §16 #90 — An import dates a book by the file's "date added"; a re-import re-dates the books already here only when the box is ticked, and the row's own time is kept for the stamp connections hold

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #90`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

"Unread for years" (#81) found nothing on a catalogue imported from Goodreads: every book carried
the day of the import as its date added, and Goodreads' own `Date Added` sat in `details`, where
no filter or sort could read it. The same was true of newest-first on every shelf. **The owner
decided** against a script to backfill the dates: the import should carry the file's date itself,
and re-importing the same export should fix the books already here — behind a box on the import
page, since it moves them on every shelf.

**What was decided:**
- **A file's "date added" is the item's.** Goodreads' and StoryGraph's `Date Added`, LibraryThing's
  `Entry Date` and libib's `added` — dropped until now — map onto `added_at` — that day at
  midnight, in the column's own datetime form — and leave `details` (#87's `storygraph_date_added`
  and `librarything_entry_date` are no longer written). A new book is always
  dated by the file: nothing is lost, and when it joined the collection over there is when it did.
  A cell that isn't a date leaves the row dated by its import, as before.
- **A book already here is re-dated only when asked.** The import page's box, *Also set the date
  added of books already here from the file*, off by default, is sent with every batch (`dates`).
  With it, a matched book whose date differs from the file's takes the file's; without it, nothing
  moves. The dry run counts the matches the file dates differently either way, so the preview can
  say what the box would do, and the run's summary says how many it dated. Only formats that merge
  (Goodreads, StoryGraph, LibraryThing — #87) can re-date; a Nalanda export always adds rows, and
  carries `added_at` already.
- **The row's own time is kept.** A connection names a book by `itemStamp()`, a hash of the id and
  the row's time, because ids are reused (#56); re-dating would have broken every feed entry,
  comment thread and borrow request a connection holds for the book. So `items.created_at` (nullable,
  migration 0051) takes the `added_at` being replaced, the first time only — the one statement
  `SET created_at = coalesce(created_at, added_at), added_at = …` — and the stamp is taken from
  `created_at ?? added_at`. Every existing stamp is unchanged, a row never re-dated has no
  `created_at`, and a book re-dated twice keeps the time it was first made here. A row a file
  dates on insert takes its insert time in `created_at` there and then (review on #130): the newest
  id is reused after a delete, and a reading site's export has many books added on one day, so a
  stamp of the id and the file's day alone could name the deleted book's successor. A row that brings
  its own time keeps it: a trash restore (#74) passes the snapshot's `created_at ?? added_at`, so a
  book back under its own id is still that book to a connection. Internal, like `session_key`: not a
  user-visible field, so not in the export.
- **Nothing else moves.** `updated_at` stays — nothing a connection sees has changed — and the item
  history trigger (#84) lists neither column, so a re-import of hundreds of books writes no history.
  Where the date shows — a shelf's newest-first order, "Unread for years", the item page's Added
  line, a share link's feed (#86) — follows the new date.

**What it rules out:** a backfill script (the import already knows the date); a second "date
added" column beside `added_at` (every sort, filter and feed would have to read both); re-dating by
default (a re-import for reads shouldn't reorder shelves); taking the stamp from anything but a
time kept with the row (a column every insert path would have to set, or a table rebuild for
AUTOINCREMENT). Any later path that changes `added_at` keeps the same coalesce, or the stamps break.

Touches §9 (nothing new is published), §12 (`added_at` indexes serve the new dates as before). Tests:
`test/csv.spec.ts` (the mappers), `test/db.spec.ts` (the merge, the stamp kept), and
`test/import-batches.spec.ts` (the page's box through the browser script).
