# §16 #59 — A year in review is one page, in the app only, counted in SQL in one D1 batch: the member's year beside the household's, and the household's plays once

**Decided:** 2026-09-30 (year in review). **Amended 2026-10-02:** #62 (2026-09-30) moved the page's link to the sidebar's Reading section; the "Catalog group" in the "chosen without asking" line below is where it first sat; and since #69 "this year" and the picker's current year are the device's day's (`todayOf(c)`), not UTC's. Cited as `ARCH.md §16 #59`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner decided the shape: `/year-in-review`, a
labelled year picker, and four groups of figures for the chosen year — books finished (re-reads count)
and pages read, with a month-by-month bar chart; most-read authors and most-used tags; the average
rating given, the highest-rated books, the longest and shortest book and the fastest read; records spun
and games played (from `plays`, #54) with the most played of each. "You" is the member's own reads
(`reads.reader_id`) and own ratings; "Household" is everyone's, former members' included (#43). Plays are
the household's log, so they show once and the page says so. Never on share pages or to connections.

**What counts.** A finished read of a book (`status = 'completed'`, `media_type = 'book'`, as a goal's
count, #49) counts in the year its `ended_on` falls in, compared as a half-open range of UTC calendar
dates (`>= 'Y-01-01' AND < 'Y+1-01-01'`), so the first and last day are in and the next year's first day
isn't. A re-read is another finish: it counts again in books, pages and the month chart. Pages are the
sum of `items.length` over finishes of books with a length (> 0); the page says how many finishes had
none. Lists count **books**, not finishes: a book is its folded title and creators (`work`), so two
editions are one book and a re-read doesn't make one book two — authors rank by books, then finishes
("1 book · 3 finishes"); tags by books carrying them. **Authors** come from `creators` split into people
(`YEAR_CREATORS`). The separator really used is ", ": Open Library, Google Books and BoardGameGeek join
several names with it, and so does the Goodreads import (author, then additional authors), so splitting only
on ';' and ' & ' would stop splitting nearly every multi-author book. But a hand-typed or libib-imported
catalogue can hold one person written "Last, First", which a plain comma split made two people ("Le Guin"
and "Ursula K."; found by nalanda-review). So a string is one person when it has exactly one comma, no ';'
or '&', no full stop before the comma, and given names after it — a single word ("Herbert, Frank") or
names ending in an initial ("Le Guin, Ursula K.", "Tolkien, J. R. R.") — and not a suffix; it is turned
round ("Ursula K. Le Guin") so it meets the same author spelled the usual way. Two full names ("Terry
Pratchett, Neil Gaiman") and anything with two commas ("A, B, C") still split; ';' and ' & ' split too
("Pratchett & Gaiman" is two). A lone "Jr."/"Sr." is dropped rather than counted as an author, and
"Martin Luther King, Jr." isn't turned round. What the rule gets wrong, knowingly: two surnames alone
("Pratchett, Gaiman") read as one person, and "Mandel, Emily St. John" as two. `work` still folds the
creators string as written, so a book held as "Le Guin, Ursula K." and "Ursula K. Le Guin" is two books.
**A rating** counts once per reader and book finished that year — the `work`, not the item, so neither a
re-read nor a second edition counts it twice, and a reader who rated two editions of one book gave it their
average of the two (the per-item grouping counted both; found by nalanda-review) — and only from the reader
who finished it, only for the editions they finished — so a rating of a book finished in another year, or
by someone who didn't finish it that year, isn't that year's. Former members, one "nobody" to the app's
checks (#43), are one reader here too. The household's highest-rated averages a book's per-reader ratings
across its readers. Longest and
shortest are among the year's books with a length; the fastest read is began → ended counting both days
(a book begun and finished the same day took one), among finishes with a start date no later than the end.
Plays count per type (`boardgame`, `vinyl` — an item since retyped away from those drops out), a total,
how many distinct items, and the three most played. Ties break by the latest finish or play, then title.

**Cost (#37, #12).** One `d1.batch()` of ten statements — one D1 call — whatever the catalogue holds:
months, authors, tags, average rating, highest-rated, longest/shortest, fastest, plays, the undated count
and member count, and the picker's years. The seven reading statements share one CTE of the year's finishes,
`MATERIALIZED` and joined to a two-row scope table, so each reads `reads` once rather than once per scope;
tags join `item_tags` by its primary key (`CROSS JOIN` fixes the order, where SQLite had chosen to scan
`item_tags` whole); plays are a range on `idx_plays_played_item`, as #54 foresaw. No index or migration was
needed at first: the year's finishes were a scan of `reads`, which at 1,500 rows is cheap. The page was 4 D1
calls on an empty instance and the same 4 with 2,000 items, 1,500 reads, 600 reviews, ~7,000 tag links and
600 plays (the session's user, the layout's shelves and the batch among them); a test counts both through the
budgeted handle, and holds the review itself to one call. Measured there, the batch read about 52,000 rows
in total (before materializing, 74,000) and returned 74, so the Worker's CPU is rendering a few dozen rows.
D1's free plan allows 5 million rows read a day: at that size, about a hundred views of the page. **Since
#68** the year's finishes are a range on `idx_reads_status_ended`; the picker's years skip from year to year on
the indexes (`YEARS_WITH_DATA`, one seek a year) instead of reading every dated finish and play; and the tags
group by tag id before each name is looked up. On that household 2024's page reads 40,064 rows (54,918
measured the old way with the same harness) and this year's 2,151 (18,253); on production's data 3,171
(6,762). The page is 3 calls: the layout's shelves and their counts are one statement.

**Undated finishes are left out, and counted beside.** A finish with no end date — Goodreads' read counts
become exactly these (#41) — is in no year, so listing it under every year would be wrong and under none
would hide why a year looks thin. The page ends with "Finished, date unknown: 1 book of yours, 3 in the
household — with no end date, they count in no year" whenever there are any, including on an empty year.

**Years and edge cases.** The picker offers every year with a dated finish of a book or a play, the current
year (UTC), and the one being shown; `?year=` takes 1000–9998, anything else shows this year (9999's range would end at "10000-01-01", which
sorts before its own dates). An
empty year says so in one panel ("Nothing yet for 2026…" this year, "Nothing for 2010…" before, "hasn't
started yet" after) and draws no chart; a year of plays without reading says "No book finished with a date
in 2025" and shows the plays; a year without plays says "No records spun" / "No games played"; a member with
no finishes sees that in their column beside a household that read.

**Accessible.** One `h1`, an `h2` per group, an `h3` per column, the picker's `<label for>`; the chart is a
`<figure>` labelled by its caption, its CSS bars `aria-hidden`, and beside them a visually hidden table —
Month, Books finished, Pages read, a row per month, captioned with whose and which year. The table is hidden
by a wrapper `div`: a table sizes to its content whatever width it is given, and on its own it widened a
390px page by 36px (found by the screenshot pass). Star ratings are hidden and read as "4.3 out of 5".
Bars use the indigo accent, ratings turmeric (`--brass`), every number monospace; the columns stack below
720px.

**Privacy.** The route sits after the session middleware (src/index.ts), so a signed-out visitor, or a
connected household's signed request (peers hold no session), gets the login redirect; share pages carry no
link to it and `/share/:token/year-in-review` doesn't exist; nothing here passes through `toPublicItem()` or
`toConnectionItem()`, and no feed kind or trigger was added. Usernames never appear on it: the columns are
"You" and "Household".

**Chosen without asking, overrulable:** reading figures are books only, as goals are; undated finishes are
counted in a note rather than listed; lists rank books (editions and re-reads folded) before finishes; the
average rating is over ratings by those who finished the book that year, once per reader and book (two
editions rated: their average); a "Last, First" author is recognised by the given-names rule above and
turned round, and ';' and ' & ' separate authors as commas do; fastest
counts both days; ties go to the latest; top five authors, tags and rated books, top three per play type; a
household of one — whose figures are all its own — sees one column, "You", not the same figures twice (a
former member's reads make the columns differ, and both show); `/year-in-review` sits in the sidebar's
Catalog group; the page doesn't compare with the year before or show the member's goal.
