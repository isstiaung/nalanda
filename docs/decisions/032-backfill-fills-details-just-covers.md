# §16 #32 — The backfill fills details, not just covers

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #32`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A catalog imported from Goodreads or libib
arrives without descriptions too, and the record that yields a cover usually carries the
description, publisher, year and page count — Google Books especially, which is why
`GOOGLE_BOOKS_KEY` earns its keep for a bulk run: the keyless quota is shared and answers 429
under load. `findCover()` now returns the record it matched, and keeps a match even when no
image can be stored, so a coverless hit still yields details. The queue widened from "no
cover" to "no cover or no description". Only blank fields are filled — never what the
household wrote — and an item that already has a cover keeps it (nothing is even fetched for
it). One item's failure no longer ends the run: each is caught, the batch reports the progress
it made, and the browser resumes past it. Batch size dropped 4 → 3, because a full-chain miss
can spend ~9 subrequests per item against the free plan's 50.
