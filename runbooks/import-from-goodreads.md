# Runbook: Import from Goodreads

Brings your Goodreads reviews, ratings, and shelves into Nalanda — both for books you
physically own (reviews merge onto them) and books you've only read (they become
"Not owned" reading-log entries, `copies = 0`). The end state: Goodreads is redundant.

## Export from Goodreads

goodreads.com → **My Books** → **Tools** (bottom of the left sidebar) → **Import and
Export** → **Export Library**. Generation takes a minute for large libraries; a download
link appears on the same page when it's ready. One CSV covers everything.

## Import into Nalanda

1. Log in → **/import**.
2. Pick the CSV and the destination library. (The Goodreads format is auto-detected —
   the "default type" and "music as vinyl" options don't apply and are ignored.)
   The destination only affects **new** entries; matched books stay on their shelf.
3. **Preview** — shows, for the first 200 rows, how many map cleanly, how many **match
   books already in Nalanda** (their reviews will merge), and how many are **new**
   (added as "Not owned"). Nothing is written yet.
4. **Import** — uploads in batches of 200 with live progress.

Unlike the libib import, **re-running is safe**: rows imported last time match by ISBN
(or title + author) on the next run and merge instead of duplicating. The rare exception
is a row with no ISBN *and* a title/author spelled differently between runs.

## Matching and merge rules

A row is matched to an existing item by, in order: **ISBN-13 → ISBN-10 → normalized
title + first-author surname** (series suffixes like "(The Broken Earth, #1)",
subtitles after ":", and initials spacing are ignored). On a match:

- **Goodreads wins** for rating, review, reading status, date read, and private notes —
  but a field Goodreads has no value for never blanks what's already in Nalanda.
- **Copies, title, and bibliographic metadata are never touched** — Nalanda's
  provider-sourced metadata is better than Goodreads CSV metadata.
- Custom bookshelves are **added** as tags (existing tags kept).

## What maps where

| Goodreads column | Nalanda |
|---|---|
| `Title`, `Author` + `Additional Authors`, `Publisher` | title, creators, publisher |
| `ISBN13` / `ISBN` (Excel guard `="…"` stripped) | `isbn13` / `isbn10_upc` |
| `My Rating` (0–5 whole stars, 0 = unrated) | half-star rating (×2) |
| `Exclusive Shelf` | status: read → completed, currently-reading → in progress, to-read → not started; a dnf/abandoned shelf → abandoned |
| `My Review` (`<br/>` → line breaks) | review |
| `Private Notes` | private notes |
| `Date Read` | completed date |
| `Number of Pages`, `Year Published` | length, published |
| `Bookshelves` (minus the three exclusive shelves) | tags |
| `Owned Copies` | copies — 0 (the Goodreads default) = "Not owned" reading-log entry |
| `Book Id` | `goodreads_book_id` in details |
| anything else (`Average Rating`, `Binding`, `Read Count`, …) | kept losslessly in the item's details JSON |

Rows without a title are skipped and counted; nothing is silently dropped.

## Going forward (no more Goodreads)

Finished a book that isn't in the catalog? **/add** → scan its ISBN or search the title →
**Log — not owned** on the result card. It creates the entry with `copies = 0` and drops
you straight into the edit form to set rating, review, status, and read date. If you own
the book, use **Add to shelf** as usual and add the review from its Edit page.

## After the import

- **Covers**: new entries arrive coverless (Goodreads CSVs carry no images). Reload
  **/import** and run **Cover backfill** — same procedure as the libib runbook.
- **Wishlist for free**: Goodreads *to-read* books arrive as "Not owned" + status
  "Not started" — filter any library view by holding **Not owned** + status
  **Not started** to see them.
- **Share pages**: "Not owned" entries appear on published share links with a badge —
  your share link doubles as your public reviews page. If a shelf shouldn't show them,
  keep reading-log entries in a separate (unshared) library.

## Verify afterwards

- Dashboard: "Items" counts owned only; a "Read, not owned" stat appears next to it.
- Spot-check one merged book (rating/review updated, copies and cover untouched) and one
  new entry (has the "Not owned" pill, lending disabled).
- `/export.csv` round-trips everything, including `copies = 0` — a good post-import
  backup.
