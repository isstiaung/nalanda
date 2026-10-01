# Runbook: Import from libib

## Export from libib

libib → **Settings → Export** → download the CSV for each collection you want to bring
over. (libib exports one CSV per library.)

## Import into Nalanda

1. Log in → **/import**.
2. Pick the CSV file, the destination library, and the options:
   - **Default type** — used when the CSV has no item-type column (libib book collections
     often don't).
   - **Treat libib "music" as vinyl** — libib files vinyl under "music"; leave this on if
     your music collection is records.
3. **Preview (dry run, optional)** — parses the file in your browser and shows how the
   first rows map: how many rows map cleanly, type counts, and a sample. Nothing is
   written yet.
4. **Import** — uploads in batches of 200 with live progress; works directly without a
   preview. A few thousand rows take a handful of seconds.

Re-running an import creates duplicates (there's no upsert) — import into an empty library
so a do-over is just delete-and-retry.

## What maps where

| libib column | Nalanda |
|---|---|
| `title`, `creators`, `description`, `publisher` | same fields |
| `ean_isbn13` / `upc_isbn10` | `isbn13` / `isbn10_upc` |
| `publish_date` | `published` |
| `status` (“not begun”, …) | reading status |
| `rating` (0–5, halves) | half-star rating (×2) |
| `length`, `copies`, `began`, `completed`, `review`, `notes`, `tags` | same fields |
| `location`, when a file has one | the private location, where it lives — never in details, which share pages show |
| `group` | becomes a tag, and the item's series — libib documents `group` as "what series an item belongs to" (it has no volume number; add it on the edit form) |
| `item_type` (book / board game / video game / music / movie) | media type (music → vinyl if opted in) |
| `media_condition` / `sleeve_condition`, if you added them (a record's grades: `VG+`, or Discogs' wording such as `Near Mint (NM or M-)`) | the record's media and sleeve grade — private, never in details; a value off the scale is dropped |
| `price` | the purchase price, in the household currency — when an admin has set one (**Members → Household currency**) before the import and the cell is a plain number like `12.99`; otherwise it stays in details. Either way it is never on share pages or to connections (ARCH.md §16 #61) |
| `purchase_price` / `purchase_currency`, if the file has them (a Nalanda export) | the purchase price, in that currency — never in details |
| `added` (the day libib catalogued it) | the item's date added, which newest-first order and "Unread for years" count from (ARCH.md §16 #90) |
| `added_by` (a Nalanda export: who added the item, by username; empty for a member removed since) | who added it — the member of that name when an admin imports, otherwise you; an empty cell or a name nobody here has is you |
| anything else (`ensemble`, `esrb`, `aspect_ratio`, …) | kept losslessly in the item's details JSON |

Rows without a title are skipped and counted; nothing is silently dropped.

A **Nalanda export that lost a column** in a spreadsheet (`details`, say) is no longer recognised
as one and is read as a libib file — the preview says so. Its type, identifiers, dates, location,
notes and price still map, and nothing private reaches details; but its reads, reviews, loans,
plays, wants and quotes are dropped, so keep every column (or put it back) before importing.

The reading status and dates, rating and review become **the importing member's own** read and
review (ARCH.md §16 #43) — import while signed in as the person whose catalogue it is. A
**Nalanda export** is different: it names each read's reader, each review's writer and who added each
item, and when an admin imports it, a name that is a member here keeps them; any other name is yours. A member's
import is always all theirs. The preview lists who gets what. A Nalanda export also brings back
every loan in its `loans` column, open and returned, onto the items it adds, whoever imports it;
a loan to a connected household comes back as an ordinary loan under the name it was lent to
(ARCH.md §16 #57). libib files have no loans.

## Covers

libib CSVs contain no cover images or URLs, so imported items start coverless — and
without descriptions. Fix both in one click: **/import → Cover backfill**. It walks every
item short of a cover or a description, in small batches with live progress, trying two
passes per item:

1. **Exact, by ISBN/UPC** — Open Library (search + raw edition record), Google Books,
   iTunes. A record's cover comes only from the MusicBrainz Cover Art Archive (by barcode,
   or a confident artist-and-title match), and its details from Discogs. All keyless
   except Discogs.
2. **By title + author** — catches items whose ISBN no provider knows (and items with no
   ISBN at all). A different *edition's* cover may be used; matches are flagged in the
   final count as "matched by title/author — worth a quick skim".

Wrong covers are treated as worse than missing covers: a cover is stored only when the
source record's title or identifiers agree with the item, so junk ISBN records and
Google's fuzzy ISBN matching can't attach a stranger's artwork.

- Safe to re-run any time: it only touches items that still lack covers.
- Whatever remains after both passes needs a human: item → Edit → paste a cover URL, or
  rescan the barcode.
- Provider quotas are respected by design (sequential lookups, small batches); a 300-book
  backfill takes a few minutes.
- For a much larger catalog, or if the run keeps stopping with "request failed (500)", run the
  backfill from your machine instead: [metadata-backfill.md](metadata-backfill.md).

## Verify afterwards

- Library page shows the expected item count.
- Spot-check a few items, including one with tags and one that had odd columns (check its
  *details* section).
- **/import → Export everything as CSV** gives you a Nalanda-format export — a good post-import
  backup.
