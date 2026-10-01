# Imports and exports

Every user-visible field leaves through `/export.csv` and comes back through the import — a rule of
the project, not a feature of a release ([CLAUDE.md](../../CLAUDE.md)). Four other formats come in.

## The Import / export page

Drop a CSV and the format is auto-detected: libib, Goodreads, StoryGraph, LibraryThing, or a Nalanda
export. The file is parsed in your browser and posted in batches of 200 rows — the Worker's 10 ms
of CPU can't parse a file ([#38](../decisions/038-csv-export-fetched-page-time.md)) — and **Preview
(dry run)** says how the rows map before anything is written: how many match, how many are new,
whose the reads become. The options are the shelf new items go on, a default type for a file
without one, whether libib's "music" means vinyl, and **Also set the date added of books already
here from the file**. A column no mapper recognises is kept in the item's details — except a
private one: `Location` and `Notes` land in those fields in every format, and anything else private
a file might carry (reads and their dates, reviews, loans, plays, grades, prices, who added it) is
dropped rather than published through details.

## From a reading site

Goodreads, StoryGraph and LibraryThing exports are **matched and merged**
([#14](../decisions/014-goodreads-csv-import-match-merge.md),
[#87](../decisions/087-storygraph-librarything.md)): a row is matched to a book already here by
ISBN-13, then ISBN-10, then title and first author (initials aside, a subtitle dropped), and the
file wins for the importer's rating and review, its notes are added after the household's, and its
shelves, read dates and read counts become reads — added, never removed. Everything else becomes a
Not owned reading-log entry, or an owned copy where the file says so (StoryGraph's Owned?,
LibraryThing's collections and Copies). Everything a file brings is the importing member's own:
each member imports their own export, and nobody's touches anyone else's reads. Re-running merges
instead of duplicating.

- **Goodreads** — shelves become tags (`read`, `currently-reading` and `to-read` become status);
  Read Count that many finished reads; a title's "(The Dark Tower, #1)" a new book's series.
  [runbooks/import-from-goodreads.md](../../runbooks/import-from-goodreads.md).
- **StoryGraph** — every dated range in Dates Read is a read of its own; star ratings in halves and
  quarters; Format the copy's form; moods, pace and content warnings your private notes.
  [runbooks/import-from-storygraph.md](../../runbooks/import-from-storygraph.md).
- **LibraryThing** — "Last, First" authors turned round; Date Started and Date Read; Media, Comment
  and Private Comment, Collections, Series and Volume, Languages; Other Call Number the location;
  money and condition dropped. [runbooks/import-from-librarything.md](../../runbooks/import-from-librarything.md).

**Date added, from the file** ([#90](../decisions/090-import-date-added.md)): a new book is dated by
the file's Date Added or Entry Date (libib's `added` likewise), so newest-first and "Unread for
years" mean what they say. A book already here keeps its date unless the box is ticked; then
re-importing the same export re-dates the matched ones, and the preview says how many.

## From libib

libib exports one CSV per collection; each imports as it is, insert-only, so re-running one
duplicates ([runbooks/import-from-libib.md](../../runbooks/import-from-libib.md)). A `group` becomes a
tag and the series; `price` the purchase price, when the household currency is set; a `location`
column the location. Imported items start coverless: run the backfill afterwards
([cataloguing.md](cataloguing.md#covers)).

## Kindle highlights

A separate form on the same page takes `My Clippings.txt` or a notebook export and makes each
highlight a quote ([reading.md](reading.md#quotes-and-highlights),
[runbooks/import-from-kindle.md](../../runbooks/import-from-kindle.md)).

## The Nalanda export

**Export everything as CSV** fetches `/export.csv` 250 items a request and joins the pages in the
browser ([#38](../decisions/038-csv-export-fetched-page-time.md)); the plain link streams the whole
catalog in one request, which a large catalog can push past the free plan's CPU limit. One row per
item: shelf, type, title, creators, ISBNs, publisher, published, series with its number and total,
description, length, status and dates, the household rating and review, `reviews` (everyone's, with
who wrote each and when), notes, location, tags, copies, `loans` and `borrowed` (every one, open
and returned, with borrower or lender, dates, contact and note), price and currency, a record's
grades, `reads` (each with its reader), `plays` (each with who logged it), progress and its
history, `wanted_by`, `purchase_links`, formats, editions, language, original title, `quotes`,
`added_by`, and `details`.

**What round-trips.** A Nalanda import adds every row as a new item — it never merges, so importing
a file twice adds everything twice — and brings back each item's tags, series, reads, reviews,
loans, borrows, plays, wants, links, editions and quotes in one batch. Names are matched as a read's
reader is: in an admin's import a name that is a member here keeps what's theirs and a former
member's stays nobody's; anything else, and everything in a member's import, is the importer's. A
date that isn't one is dropped rather than guessed at, and so is money without a currency or a
grade off the scale. Older exports import without the columns they lack.

**Not in the CSV**, by decision: reading goals, saved views and display names — about people and the
household, not items; backups carry them — covers, which the backfill refetches, API tokens, and
connections' data, which an admin exports as JSON from **Borrowed → Export connections data**.

**No formulas** ([#91](../decisions/091-csv-formula-guard.md)): a cell beginning with `=`, `+`, `-`,
`@`, a tab or a carriage return leaves with a `'` in front, which spreadsheets show as text, and the
import takes exactly that one quote off again.

## Backups

`npm run backup` exports every table, data only, to `backups/remote-<date>/`
([#10](../decisions/010-backups-per-table-data-exports.md)) — D1 can't dump a database holding an
FTS5 index, so the schema comes from `migrations/` and the search index rebuilds on restore.
[runbooks/backup-and-restore.md](../../runbooks/backup-and-restore.md) covers routine backups, D1's
Time Travel, restoring, and keeping a restored copy away from your connections.
