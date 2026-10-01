# §16 #46 — "Read next" suggests from the signed-in member's own reads, at random, in one query

**Decided:** 2026-09-30 (what to read next). Cited as `ARCH.md §16 #46`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The
owner asked for a card on the Overview that picks a book to read, "nothing too complex", and
decided its rules:
- **Books only**, and **any book** in the catalog, owned or not; a pick with `copies = 0`
  carries the usual "Not owned" pill.
- **The pool is personal**: a book the member hasn't finished (no completed read of theirs) and
  isn't reading now (no open read of theirs). Other members' reads don't count, so the
  household's `items.status` (#43) is never consulted — a book someone else finished is still
  the member's to read. A read they stopped leaves the book in the pool.
- **Two buttons, no filters.** "Start reading" posts to the book page's own
  `POST /items/:id/reads/start` without htmx, which opens the member's read and redirects to
  the book, so reading starts one way everywhere. "Another" draws again and never shows the
  book just shown while any other qualifies.

**Random in SQL.** `pickNextRead()` filters `items` to books with a `NOT EXISTS` on `reads`
(the `idx_reads_item` lookup) and orders by `id = <just shown>, random()` with `LIMIT 1`: the
book just shown sorts last, so it comes back only when it is the whole pool, and under
`LIMIT 1` SQLite's sorter holds one row rather than the whole pool. Measured on about 2,000 items (1,800 books, 1,333
reads): one D1 call reading about 5,000 rows — the same order as the Overview's per-type
counts, which scan the catalog already — and about a millisecond locally. A `NOT IN` over the
member's reads read more rows (it scans every read), so it stayed correlated.

**One handler, two renders.** "Another" is a GET form for `/?not=<id>`: htmx asks with
`HX-Request` and the Overview's handler answers with the card alone — the session's user and
the pick, 2 D1 calls — swapped into `#read-next`, which is an `aria-live` region; the new
"Another" keeps its id, so htmx gives it focus back. Without htmx the same URL is the whole
Overview with a new pick. The response says `Vary: HX-Request`, since one URL answers both
ways. The full Overview goes from 9 D1 calls to 10, whatever the catalog's size (budget 50,
#37); tests hold both counts. This holds only while nothing else sends htmx to `/`: htmx 2
restores history with `HX-Request` set when its cache misses (`historyRestoreAsHxRequest`),
so if `hx-boost` or `hx-push-url` ever arrives, the card must move to its own partial URL
(e.g. `/read-next`) rather than vary `/` on the header (noted by nalanda-review).

**Chosen without asking, overrulable:** an empty pool shows a one-line "Nothing to suggest"
in the card's place rather than dropping the card — a card that vanishes once you've read
everything looks like a bug, and "Another" needs somewhere to land if the pool empties
between clicks — but a catalog with no books at all leaves the card off, since there is
nothing it could ever suggest and the Overview already says the shelves are empty; the card
sits between the totals and the shelves; a stopped read doesn't take a book out of the pool
(the owner's rule names finished and open reads only).
