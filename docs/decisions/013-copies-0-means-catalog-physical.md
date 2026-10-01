# §16 #13 — `copies = 0` means "in the catalog, not in the physical collection"

**Decided:** 2026-07-18 (reading log (Goodreads redundancy, phase 1)). Cited as `ARCH.md §16 #13`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

— the
representation for reviewed/rated books that were never owned (Goodreads history,
library loans, borrowed books). Chosen over a new `ownership` column (the count
already expresses it, and export/import round-trips it with zero new surface) and
over a separate "reading log" library (a book you later buy shouldn't have to move
shelves). Consequences: lending is blocked at `copies = 0` (UI + server), the
library view gains an owned/not-owned filter, and the dashboard "Items" stat counts
owned only, with a separate "Read, not owned" stat. Share pages *include* these
items — deliberate: share links double as the public reviews page — badged via a
whitelisted derived boolean (`inCollection`); the raw count stays private (§9).
