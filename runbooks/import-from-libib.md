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
3. **Preview** — parses the file in your browser and shows how the first rows map: how
   many rows map cleanly, type counts, and a sample. Nothing is written yet.
4. **Import** — uploads in batches of 200 with live progress. A few thousand rows take a
   handful of seconds.

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
| `group` | becomes a tag |
| `item_type` (book / board game / video game / music / movie) | media type (music → vinyl if opted in) |
| anything else (`ensemble`, `esrb`, `aspect_ratio`, prices, …) | kept losslessly in the item's details JSON |

Rows without a title are skipped and counted; nothing is silently dropped.

## Covers

libib CSVs contain no cover images or URLs, so imported items start coverless. Fix it in
one click: **/import → Cover backfill**. It walks every coverless item in small batches
with live progress, trying two passes per item:

1. **Exact, by ISBN/UPC** — Open Library (search + raw edition record), Google Books,
   iTunes; Discogs and the MusicBrainz Cover Art Archive for music barcodes. All keyless
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

## Verify afterwards

- Library page shows the expected item count.
- Spot-check a few items, including one with tags and one that had odd columns (check its
  *details* section).
- `/export.csv` gives you a Nalanda-format export — a good post-import backup.
