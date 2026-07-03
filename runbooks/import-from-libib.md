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
one click: **/import → Cover backfill**. It walks every item that has an ISBN/UPC but no
cover — in small batches, with live progress — looking each one up on Open Library, then
Google Books (Discogs for barcoded vinyl), and stores what it finds in R2.

- Safe to re-run any time: it only touches items that still lack covers.
- Items with no match at any provider stay coverless — add those manually (item → Edit →
  paste a cover URL) or rescan the barcode.
- Provider quotas are respected by design (sequential lookups, small batches); a 300-book
  backfill takes a couple of minutes.

## Verify afterwards

- Library page shows the expected item count.
- Spot-check a few items, including one with tags and one that had odd columns (check its
  *details* section).
- `/export.csv` gives you a Nalanda-format export — a good post-import backup.
