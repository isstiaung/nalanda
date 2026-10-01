# §16 #43 — Reads and reviews are each member's; the item keeps the household's summary

**Decided:** 2026-09-28 (each member's reading). Cited as `ARCH.md §16 #43`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A household
shared one status, one rating and one review per book, so two people reading the same book
overwrote each other, and nobody could say who had read what. `reads` gains `reader_id`, and
ratings and reviews move to a `reviews` table, one per member per item. **The owner chose to
keep one household value wherever a book is filtered or published**, derived from everyone's
rows, so every shelf, status filter, share link, connection view, activity trigger and export
column goes on reading the item's own columns:
- **status** is Completed if anyone has a finished read, else In progress if anyone has an open
  one, else Abandoned if there are only stopped reads, else Not started — the same ordering #41
  used, now over everyone's reads, so `READ_STATE_SET` is unchanged but for progress;
  `completed_on` is the latest finish by anyone, `read_count` everyone's finishes, and
  `rereading` an open read, by anyone, of a book finished before, by anyone — so a member's
  first read of a book someone else finished shows as re-reading, and nothing moves between
  views while it's read (until #64, which lists it under In progress too);
- **progress_page** is the latest page recorded in any open read (with none open, the deciding
  read's last page, as before) — what "progress on share pages" shows;
- **rating** is the average of everyone's ratings, rounded to the 1–10 scale, and **review** the
  one written most recently, by `reviews.reviewed_at`, with no author. `refreshReviewState()`
  rides in the batch of every review write (#39), as `refreshReadState()` does for reads, and
  writes an item only when its summary changed (an `UPDATE … FROM`), stamping `updated_at` then:
  connections see that time, and an average that didn't move is no change to the book. So a
  second member's rating that moves the average is a "rated" entry, dated now (#40), one that
  doesn't move it records nothing, and inside an import's marker it is dated by the book's
  last finish or left out, as before. A review or rating taken away isn't news: the trigger
  sees only that the item's review changed, so when a member's newer review goes and an older
  one shows again, the same batch dates the replacement entry by when the review now shown was
  written (`reviewed_at`), and a rating entry by when the latest remaining rating was given
  (`rated_at`, which only a change of the rating's value moves — dating it by `updated_at`
  re-announced a 2019 rating as news after its review's text was edited, found by nalanda-review)
  — never later than the trigger dated it, so something just written keeps its time
  (`redateReviewActivity()`; found by the adversarial pass, which saw a 2019 review re-announced
  as today's). `summarizeReviews()` is
  the refresh's TypeScript twin, held to it by a test.

For a household of one every rule reduces to v1.2.1's, and the existing suite — run as one
member owning what it seeds — passes unchanged in substance. **Inside the app** each person's
reading shows on the book's page under their name, and everyone's rating and review with their
username — but only once the household has more than one member, or someone other than the
viewer has read or reviewed the book: a household of one sees the page, the edit form and the
shelf exactly as before. "Read again", Finish, Stop and Record act on the signed-in person's own
reads, so another member can start their first read of a book someone finished; the edit form's
status, dates, rating and review are the editor's own, and its re-read lock and "use Read again"
refusals are per person. A record's or game's "Not started" clears only the editor's reads, so
its page lists everyone's reads by name too (once there is more than one member), where the
reader or an admin corrects, finishes, stops or deletes one and an admin moves it; starting a
read and pages stay a book's. On a book's page too an admin gets Finish and Stop on anyone's
open read, which the routes always allowed.

**Permissions.** Members change their own reads, pages and review; admins anyone's. Every route
checks and answers 403 with a reason, and every statement that writes checks again (`Actor`,
`allowed()` in queries.ts), so a check and its write can't come apart and a hand-made request
changes nothing. Pages belong to their read's reader. **Admins can move** a read — with its pages
— or a review to another member, to fix misattributed history; a move is refused onto someone
already reading the book (their one open read) or who already has a review of it (one each, and
merging two reviews is a person's call). **The "Read by" filter** narrows a shelf or a search to
what someone finished (me, not me, a member by name, anyone) or is reading now. It is
deliberately not part of `ItemFilters`, the type share links and connection views capture, so
`shareFilters()`, `itemMatchesShare()` and the connection-view filters have no room for it and
stayed untouched; the publish form carries no field for it, and the shelf says a link made from
a filtered view shows it without "Read by". It is offered once there is more than one member.

**Existing data goes to the first admin** (the lowest-id admin), the owner's call: migration
0024 (generated) adds the column, replaces the open-read index with one per (item, reader) and
makes `reviews`; 0025 (hand-written) credits every read and every page to that admin and makes
one review per item with a rating or review, holding exactly what the item holds, its text and
its rating dated by the item's `updated_at` — the last either could have been given. The items themselves aren't
touched and no trigger fires. Rehearsed on production's backup of 2026-09-28 (0000–0023, the
per-table restore, then 0024–0025): all 27 pre-existing tables identical in every pre-existing
column; 381 of 381 reads and the one page to the admin; 359 reviews (153 rating only, 20 review
only, 186 both), each matching its item, with `rated_at` set on all 339 rated ones and no other;
statuses 376 / 2 / 1,620 with 2 re-reading, as before; and recomputing both summaries over all
1,998 items with the new SQL changed nothing in any of the 28 tables. (Re-rehearsed on
2026-09-29 after `rated_at` joined 0024 — regenerated, since neither migration had reached a
persistent database — with the same numbers.) Other self-hosters' history is credited to their first admin too, which the
changelog says, with how to move it. **Removing a member** keeps their reads, pages and reviews,
unattributed ("Former member"); `deleteUser()` clears `reads.reader_id` itself, since drizzle-kit
drops ON DELETE on ALTER TABLE and D1 enforces foreign keys (a test fails with "FOREIGN KEY
constraint failed" without it). The household's summary doesn't change.

**Export and import.** The `reads` cell's tokens gain `@reader` (the username, percent-encoded so
no name can break the cell; an empty name is a former member; no `@` is an export from before
readers). A new `reviews` column holds everyone's reviews as JSON, with their writers and when
each text was written and rating given (`at`, `ratedAt`; a cell without `ratedAt` takes `at`,
else the import's time). As in the reads cell, an entry with no `by` is the importer's and an
explicit null or empty one a former member's; `rating` and `review` stay beside it as the household summary for anything that reads only
those. On import a name that is a member here keeps them — but only in an admin's import: a
member changes only their own reading, so a member's import is all theirs, or it would let them
write in someone else's name. Any other name, and anything that names nobody — an older export,
a libib or Goodreads row — is the importer's, and the preview lists each name, what it brings
and whose it becomes. Two names landing on one person keep one open read and the review written
last; several former members keep an open read each, as the database holds them. Reads are
capped at 100 per reader, as the app caps them, and 1,000 a row. A 1.3 export doesn't import
correctly into an older version, whose parser reads `2020-01-01@asha` as no date; the changelog
says so. A Goodreads file is its importer's: it is reconciled with their
reads alone and merges into their review, so it never touches anyone else's.

**Chosen without asking, overrulable:** `reviews.reviewed_at` and `rated_at` beside the
recommended columns — without the first, re-rating a book would make an old review the
household's latest and announce it as new; without the second, rewording a review would make its
old rating news when another's goes; the migration's review times come from `items.updated_at`; migration 0025 also re-credits a
page another member recorded, so a read and its pages agree; the book page names people only in
a household of more than one; progress among open reads is the latest page by anyone; a page
recorded before reads (none on production) joins its recorder's first read; the per-read cap of
100 is per reader; the Read by default is "Read by…" (no filter), with "anyone" meaning someone
finished it; removing a review or rating is not news. NULL readers are one "nobody" to the app's checks (`IS`), though SQLite's unique index
treats NULLs as distinct and so doesn't hold unattributed open reads to one; nothing in the app
opens one.

*Amended by #45:* members' names can reach share pages and connections as display names —
never usernames — when an admin switches them on; off, as above. *And by #49:* a new instance
starts with them on; an upgraded one keeps what it had.
