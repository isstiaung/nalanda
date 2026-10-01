# §16 #40 — Feed activity is dated by when it happened, and an import isn't news

**Decided:** 2026-09-28 (measured, not assumed). Cited as `ARCH.md §16 #40`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The first-view
backfill dated entries by `items.updated_at`, and a Goodreads import (all 1,998 items on one
day) and two metadata backfills had rewritten that on every item within the 90-day window, so
sharing a first view would have offered followers the newest 300 of years of reviews, ratings
and finishes as if they were new. The triggers had the same flaw from the other side: `at` was
always now, so a 2019 read imported while a view was shared reached followers as today's
finish. Receivers sort by the entry's date and keep only their retention window, so the fix is
the date itself. The backfill takes only activity with a date of its own: a finish by its
`completed_on`; a rating or review, which has no timestamp, by its book's `completed_on` —
and one without is left out, since nothing else says when it was given (`added_at` doesn't:
Goodreads' "Date Added" lands in `details`, so imported items are added the day of the
import). Progress keeps its own time, and an update already in the log isn't added again.
The triggers (migration 0021) date a finish by `completed_on` when that's before today, and a
rating or review by now: re-rating a book read years ago is news the day it happens. Only an
import can't be told from that by the data, so an import says so: its batch inserts a row in
`import_in_progress` first and deletes it last, and while the row exists all three kinds are
dated by `completed_on`, clamped to now, and a read with no usable date records nothing. One
batch, so the marker can't outlive the import or miss a row of it; a failed import rolls it
back with everything else. Considered and set aside: dating ratings by `completed_on` always
(buries genuine re-ratings), and suppressing everything during imports (loses a read finished
last week and imported today, which is news). A new follower's first page is the newest by
date, not by id, since an import's old reads now carry new ids and old dates; its cursor is the
highest id it sent. The first view and its opening entries are one batch. Deleting the last view clears the log in the
same batch, so a stale log can't survive to the next first view.
