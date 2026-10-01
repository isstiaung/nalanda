# §16 #9 — Backfill extended: a title-and-author pass, with identity guards for unattended matching

**Decided:** 2026-07-03 (after the first real import (315 books)). Cited as `ARCH.md §16 #9`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Backfill extended after the first run left 41 misses. Pass 1 (exact, by ISBN/UPC):
OL search → OL edition record → Google Books → iTunes Search (keyless); Discogs →
MusicBrainz/Cover Art Archive (keyless) for music barcodes. Pass 2 (title + author):
OL/GB for books, BGG for board games, Discogs for vinyl — also covers items with no
identifier at all. **Identity guards are mandatory for unattended matching** (learned
live: a polluted-but-checksum-valid ISBN pulled a stranger's cover, and GB
fuzzy-matches unknown ISBNs): a cover is stored only if the source's title matches the
item (`titlesMatch`) or its identifiers echo the query, and title-pass candidates must
also pass `creatorsMatch`. iTunes/MusicBrainz are cover-art-only helpers, not full
metadata providers.
