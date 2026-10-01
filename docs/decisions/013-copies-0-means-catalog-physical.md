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

**Amended 2026-10-01:** a Not owned item never claims a read on a share page. `toPublicItem()`
added "Read N times" (#41) and, with `progress_on_shares` on, a current page to a `copies = 0`
item as to any other, while CLAUDE.md's rule read "A Not owned item never claims a read" and
docs/privacy.md narrowed that to status. The owner decided for the rule as written: neither
`readCount` nor `progress` is added while `copies` is 0. What the household read of a library
book or a Goodreads entry is its own; the page says "Not owned" and no more. Owned, the same
reading shows as before; connections are unchanged (`toConnectionItem()` carries its own
`readCount`).
