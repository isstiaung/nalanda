# §16 #35 — Progress reaches connections as a timeline: every update its own feed entry

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #35`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The
household chose that over "latest progress per book". `activity_log`'s (item, kind)
uniqueness became partial (`WHERE kind <> 'progress'`) so progress accumulates while 0007's
`INSERT OR REPLACE` still collapses reviews, ratings and finishes — a test proves both. An
entry points at its update through `progress_id`, so it carries the page it recorded, not
where the book is now. That column has no `ON DELETE CASCADE`: drizzle-kit silently drops
the clause when adding a column by `ALTER TABLE`, and D1 enforces foreign keys, so
`deleteProgress()` deletes the entry itself, first (the test fails with "FOREIGN KEY
constraint failed" without that). Sharing is on by default and a household-wide switch on
Connections; switching it off stops new entries and, through `stillShows`, withdraws sent ones
by the ordinary removal check. Older peers skip the unknown kind and keep going, because
`parseFeedPage` drops unparseable entries rather than the page. On the Feed page a book's
updates gather in its card as a timeline instead of each taking a card, keeping "one card per
book per household"; "reading" gives way to "finished" once it is. Every entry counts against
the receiver's `maxEntries`, so a busy reader's updates can push older entries out of a
connection's stored feed — the receiver's cap, chosen by the receiver.
