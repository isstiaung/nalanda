# §16 #8 — Cover backfill shipped in v1

**Decided:** 2026-07-03 (after the first real import (315 books)). Cited as `ARCH.md §16 #8`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Cover backfill shipped in v1: `POST /api/backfill-covers` walks coverless items in
client-driven batches (same pattern as import, for the same subrequest/CPU reasons).
Placeholder images are rejected: OL cover URLs use `?default=false` and `storeCover()`
enforces a minimum size.
