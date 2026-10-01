# §16 #41 — Each read of a book is a row, and a re-read keeps the book Completed

**Decided:** 2026-09-28 (reading a book again). Cited as `ARCH.md §16 #41`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A book had one
status and one pair of dates, so reading it again overwrote the first read, and nothing
counted reads. `reads` now holds one row per read — status (`in_progress`, `completed`,
`abandoned`), began, ended — with at most one open read per item (a partial unique index).
It is the source of truth; `items.status`, `began_on`, `completed_on`, `progress_page` and
the new `read_count` and `rereading` stay as a cache of it, because every shelf, filter,
share view, connection view, trigger and the export already read those columns and a shelf
can't afford a subquery per item. One statement, `refreshReadState()`, derives them, and
rides in the same batch as every write to reads (#39); `summarizeReads()` is its TypeScript
twin for inserts, and a test holds them together. **The owner chose that a re-read keeps
the book Completed** (over moving it to In progress, and over making Completed filters
match anything ever finished): status comes from the last finished read if there is one,
else the open one, else the last stopped one, so nothing moves between status-filtered
views — shelves, share links, connection views — while a book is read again. `rereading`
(an open read on a finished book) marks it instead, as a dashed indigo pill wherever
status shows; `began_on` and `completed_on` stay the last finish's, and `completed_on`
moves when a re-read finishes. A stopped re-read is kept, as a stopped read with the page
it reached — the history is the point, and Delete removes one made by mistake — and the
book stays Completed. A finished book takes no page until "Read again" opens a read
(amending #34), so a page typed on the wrong book can't start anything. **Chosen without
asking, overrulable:** with progress on share pages switched on, a re-read's progress shows
like a first read's — the setting means "what I'm reading now". The edit form's status and
dates edit the read that decides status, and it refuses what a read can't be — dates on a
book not started, a completion date in progress, "Not started" for a book with reads —
rather than guess. Share pages gain `readCount` from two finishes on ("Read N times"),
always on, through `toPublicItem`; the reads and their dates stay private. Connections get
`readCount` on every item — on a progress entry, the finished reads before the one its page
belongs to, so a receiver can tell a re-read's pages from a first read's — and the Feed says
"re-reading" and "finished again"; older versions ignore the field. No trigger changed: a
finished re-read moves `completed_on`, and 0021's trigger already records a finish on that,
dated by it (#40), inside an import too; starting or stopping a re-read changes neither
column and records nothing. The export gains `reads` (`status:began..ended`, oldest first)
and `read_count`; progress entries name their read (`#n`); a Nalanda re-import rebuilds the
reads, and an older export still imports from its status and dates. Goodreads' Read Count,
which the import had kept in details, becomes undated finished reads, capped at 100, and
leaves details; a Goodreads merge adds reads and never removes one (amending #14), and a
second run adds nothing, even after reading done here since the first — a read finished,
stopped or started again here counts as the result a rule looks for. While a book is being
read again, its edit form's status and dates are shown locked: they describe its last
finish, and the re-read is managed on its page, so the form can't turn that finish into a
stop or overwrite its date. On any finished book the form offers only Completed, and the
route refuses In progress ("use Read again") and Abandoned: either would reopen or
relabel the last finish, and "set it back to In progress" was the old way of saying
"reading it again". Migration 0023 does the same for what is there already, inside
the import marker so none of it is news: on production's data (backup of 2026-09-28,
rehearsed through 0012 → 0023) it made 381 reads, left 20 of 22 tables identical, removed
only `read_count` from 1,681 details, and changed 8 statuses — 6 books not started that
Goodreads counted as read once became Completed, and 2 books in progress that had been
finished before became Completed and re-reading, so they leave the in-progress connection
view. Code from before 0023 writes status without reads, so a deploy of it goes out when
nobody is editing and the Worker isn't rolled back past it (runbooks/deploy.md). Reads were
household-level like status (§5); per-read ratings or reviews stay out of scope. *Amended
by #43:* reads are each member's, the item's columns their household summary, and ratings
and reviews per member. One consequence predates reads and stays: `completed_on` is the last finish, so
deleting the latest finish, or adding a past finish newer than the current one, moves it, and
0021's trigger announces a "finished" dated by the new date — dated honestly, but announced.
*Amended by #64 (2026-09-30):* the filters changed — a book being read again stays Completed
in the column, but every Status filter (shelf, share link, connection view) lists it under In
progress too, so it no longer stays out of In progress views; its status pill says "Re-reading".
