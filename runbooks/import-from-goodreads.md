# Runbook: Import from Goodreads

Brings your Goodreads reviews, ratings, and shelves into Nalanda — both for books you
physically own (reviews merge onto them) and books you've only read (they become
"Not owned" reading-log entries, `copies = 0`). The end state: Goodreads is redundant.

## Export from Goodreads

goodreads.com → **My Books** → **Tools** (bottom of the left sidebar) → **Import and
Export** → **Export Library**. Generation takes a minute for large libraries; a download
link appears on the same page when it's ready. One CSV covers everything.

## Import into Nalanda

1. Log in **as the person whose Goodreads export it is** → **/import**. Everything the file
   brings — reads, rating, review — becomes that member's own (ARCH.md §16 #43). Each member
   imports their own export; nobody's import touches anyone else's reads or review.
2. Pick the CSV and the destination library. (The Goodreads format is auto-detected —
   the "default type" and "music as vinyl" options don't apply and are ignored.)
   The destination only affects **new** entries; matched books stay on their shelf.
   Tick **Also set the date added of books already here from the file** if the matched
   books should take Goodreads' `Date Added` too ([below](#dates-added)) — off by default.
3. **Preview (dry run, optional)** — shows, for the first 200 rows, how many map
   cleanly, how many **match books already in Nalanda** (their reviews will merge), how
   many are **new** (added as "Not owned"), how many **reads** it would add or date, and how
   many matched books the file **dates** differently. It names you as the member they'll
   be credited to. Nothing is written yet.
4. **Import** — uploads in batches of 200 with live progress. Works directly without a
   preview.

Unlike the libib import, **re-running is safe**: rows imported last time match by ISBN
(or title + author) on the next run and merge instead of duplicating. The rare exception
is a row with no ISBN *and* a title/author spelled differently between runs.

## Matching and merge rules

A row is matched to an existing item by, in order: **ISBN-13 → ISBN-10 → normalized
title + first author** (series suffixes like "(The Broken Earth, #1)", subtitles after ":",
and initials spacing are ignored; titles in any script count; the surname and then the whole
name must agree, written either way round — "Le Guin, Ursula K." is "Ursula K. Le Guin", but
Brian Herbert's *Dune: House Atreides* never merges onto Frank Herbert's *Dune*). On a match:

- **Goodreads wins** for *your* rating and review, and for the book's private notes — but a
  field Goodreads has no value for never blanks what's already in Nalanda. Another member's
  rating and review stay as they are; the book's rating on shelves and share pages becomes the
  household's average, and its public review the one written last.
- **Reading arrives as your reads, which are added and never removed** (ARCH.md §16 #41). Each
  rule checks for its own result among *your* reads — another member's finish on the same day
  isn't yours — and reading you did here since an earlier import counts as that result. So importing the same file again adds nothing, even after you
  finished, stopped or started a book again here:
  - `Date Read` is a finish. Nothing happens if a finished read already ends that day. On
    the read shelf it closes an open read that began by then. Otherwise it dates an undated
    finished read, or adds one.
  - On the read shelf with no finished read, the open read closes, or an undated finish is
    added.
  - Currently-reading makes sure a read is open, starting on `Date Started` when the file
    has it (the standard export doesn't). Its `Date Read` is the *previous* finish, so a
    currently-reading book that was finished before arrives as Completed and re-reading. If
    a read here began since, or ended after that previous finish, that read was this one,
    and nothing is reopened.
  - A DNF shelf stops an open read that began by the DNF's date. Otherwise it records a
    stopped read, and a read started here since stays open. Once a stopped read is here, it
    does nothing.
  - `Read Count` tops the finished reads up with undated ones, capped at 100 a book.
  - A to-read shelf over there never removes a read recorded here.
- **Copies, title, and bibliographic metadata are never touched** — Nalanda's
  provider-sourced metadata is better than Goodreads CSV metadata.
- Custom bookshelves are **added** as tags (existing tags kept).
- **The date added moves only when the box is ticked** — see the next section.

## Dates added

A book's *date added* is what newest-first shelves order by and what "Unread for years"
counts from, so it should be when the book joined your collection, not when a file was
imported (ARCH.md §16 #90). A **new** entry is always dated by the row's `Date Added`. A
**matched** book keeps its date unless **Also set the date added of books already here from
the file** is ticked; then it takes the file's where the two differ. So a catalogue imported
before this existed is put right by re-importing the same export with the box ticked: the
preview says how many books it would date, the summary how many it did, and a second run
with the same file changes nothing. Nothing else about the book moves — not its "updated"
time, not its history — and connections keep every reference they hold.

## What maps where

| Goodreads column | Nalanda |
|---|---|
| `Title`, `Author` + `Additional Authors`, `Publisher` | title, creators, publisher |
| a `Title`'s series suffix, e.g. "The Gunslinger (The Dark Tower, #1)" | a new book's series and number — the title keeps the rest ("The Gunslinger"). Only the first of several series; an omnibus "#1-4" gets the series without a number. A book the row merges into keeps its own title and series |
| `ISBN13` / `ISBN` (Excel guard `="…"` stripped) | `isbn13` / `isbn10_upc` |
| `My Rating` (0–5 whole stars, 0 = unrated) | your half-star rating (×2) |
| `Exclusive Shelf` | reads, and so status: read → a finished read, currently-reading → an open read, a dnf/abandoned shelf → a stopped read, to-read → none |
| `My Review` (`<br/>` → line breaks) | your review |
| `Private Notes` | private notes |
| `Date Read` | the finished read's date, and so the completed date |
| `Date Started` (if present) | the start of the read it belongs to |
| `Read Count` | that many finished reads, undated beyond the one `Date Read` dates — "Read N times" on share pages from two |
| `Number of Pages`, `Year Published` | length, published |
| `Bookshelves` + any custom exclusive shelf (e.g. `to-re-read`) | tags — only the three built-ins (`read`, `currently-reading`, `to-read`) are dropped, since status captures them |
| `Owned Copies` | copies — 0 (the Goodreads default) = "Not owned" reading-log entry |
| `Date Added` | the book's date added — always for a new entry, for a matched one only with the box ticked |
| `Book Id` | `goodreads_book_id` in details |
| `Location`, `Notes`, if you added them — or any column of a Nalanda export (`loans`, `reads`, the dates, grades, prices…) | the private location and notes; everything else private is dropped — nothing of it ever lands in details, which share pages show |
| anything else (`Average Rating`, `Binding`, …) | kept losslessly in the item's details JSON |

Rows without a title are skipped and counted; nothing is silently dropped.

## Going forward (no more Goodreads)

Finished a book that isn't in the catalog? **/add** → scan its ISBN or search the title →
**Log — not owned** on the result card. It creates the entry with `copies = 0` and drops
you straight into the edit form to set rating, review, status, and read date. If you own
the book, use **Add to shelf** as usual and add the review from its Edit page.

Reading one again? Its page has **Read again**: the book stays Completed, marked
re-reading, while you record pages; **Finish** or **Stop re-reading** closes that read.
Every read, earlier ones included, is listed on the book's page — correct, delete, or add
a past one there.

## After the import

- **Covers and descriptions**: new entries arrive coverless, and Goodreads exports carry no
  descriptions either. Reload **/import** and run **Cover backfill** — same procedure as the
  libib runbook. Whatever record supplies the cover also fills an empty description,
  publisher, year or page count; your own writing is never overwritten. Most descriptions
  come from Google Books, so set `GOOGLE_BOOKS_KEY` before a big run — the keyless quota is
  shared and starts refusing requests under load. For a catalog of hundreds, or if the run
  keeps stopping with "request failed (500)", run it from your machine instead:
  [metadata-backfill.md](metadata-backfill.md).
- **Wishlist for free**: Goodreads *to-read* books arrive as "Not owned" + status
  "Not started" — filter any library view by holding **Not owned** + status
  **Not started** to see them.
- **Share pages**: "Not owned" entries appear on published share links with a badge —
  your share link doubles as your public reviews page. If a shelf shouldn't show them,
  keep reading-log entries in a separate (unshared) library.

## Verify afterwards

- Dashboard: "Owned" counts owned only; a "Not owned" stat appears next to it, with a
  per-media-type breakdown under each (e.g. "94 books").
- Spot-check one merged book (rating/review updated, copies and cover untouched) and one
  new entry (has the "Not owned" pill, lending disabled).
- The CSV export (**/import → Export everything as CSV**) round-trips everything, including
  `copies = 0` — a good post-import backup.
