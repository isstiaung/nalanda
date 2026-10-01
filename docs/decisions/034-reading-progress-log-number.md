# §16 #34 — Reading progress is a log, not a number

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #34`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

"Page 187" on its own answers where you are;
the reading log answers how the book has been going, which is what a Goodreads-style progress
update is really for — so `reading_progress` keeps one row per update and `items.progress_page`
carries the latest, denormalised, because a shelf row can't afford a subquery per item under
the 50-query budget. Recording a page starts the book (`not_started` → `in_progress`, and
`began_on` if it was empty), because recording a page is what starting a book looks like; an
explicitly set status or date is never touched. Deleting an entry recomputes the latest page but
leaves status and `began_on` alone — a mistyped page is not a claim the book was never opened.
Pages aren't capped at `length`: provider page counts are routinely wrong, so percentages clamp
at 100 instead of refusing a real page number. Books only. Both the latest page and the whole log
leave through `/export.csv` (`progress_page`, and `progress_history` as `page@timestamp` pairs);
neither libib nor Goodreads exports progress, so there is nothing to map on import. On share
pages it is an admin's choice, off by default — how far through a book someone is reads more
like a private note than a published review, but some households want a public "reading now"
— stored in a single-row `site_settings` table whose missing row means every default, so a
fresh instance needs no setup (§9). It reaches connections separately, as feed entries (§16 #35).
*Amended by #41:* a page belongs to a read and goes only to an open one — a finished book takes
none until "Read again" — and `progress_page` is the current read's latest.
