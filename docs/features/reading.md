# Reading

The reading life around the catalog: everyone's own reads and reviews, with one household summary
wherever a book is filtered or published.

## Everyone's own reads

Each read of a book is kept — its status, start and end dates, and the pages recorded during it —
and each belongs to the member who read it
([#41](../decisions/041-read-book-row-re-read.md), [#43](../decisions/043-reads-reviews-members-item-keeps.md)).
**Start reading**, **Record** a page, **Finish**, **Stop** and **Read again** on a book's page act
on your own reads; another member can start their first read of a book you finished, and two people
can read one book at once. Once the household has more than one member, a book's page lists each
person's reads under their name, where the reader or an admin corrects a read's dates, deletes one
made by mistake or adds a past one; only admins move a read (with its pages) or a review to another
member, to fix misattributed history. A removed member's reads stay, as a former member's.

**The household's status** is what shelves, filters and published views use: Completed once anyone
has finished the book, In progress while anyone is reading it, Abandoned when there are only stopped
reads, Not started otherwise. The read count counts everyone's finishes ("×2" beside the finished
date on a shelf), and the last finish is the latest by anyone.

**Re-reading.** **Read again** on a finished book opens a new read. The book stays Completed, marked
**Re-reading**, and counts as In progress in every status filter — shelves, share links, connection
views — until that read is finished or stopped ([#64](../decisions/064-book-being-re-read-counts.md)).
A finished re-read moves the completed date and adds to the count; a stopped one is kept, with the
page it reached. The edit form's status and dates are the editor's own and are locked while a
re-read is open; the form never turns a finished book back to In progress — that is what Read again
is for. A book read more than once says "Read N times" on share pages, and connections see
"re-reading" and "finished again".

**The "Read by" filter** on shelves and search narrows to what you, or anyone, have finished or
not, or is reading now. It is never publishable ([shelves-and-search.md](shelves-and-search.md#the-filter-bar)).

Board games and records take plays, not reads ([below](#plays-and-game-night)), and show no reading
status.

## Progress

Record the page you're on and the book keeps the log of how you got there, with how far through
you are ([#34](../decisions/034-reading-progress-log-number.md)). Recording a page starts a book that
wasn't started; pages aren't capped at the book's length, since providers' page counts are often
wrong. A finished book takes no page until you read it again. The latest page and the whole log
leave through the CSV. Connected households follow it page by page in their feed
([#35](../decisions/035-progress-reaches-connections-timeline-every.md)); it stays off public share
links unless an admin switches **Reading progress on share pages** on, and then shows only for a
book being read now.

## Ratings and reviews

Half-star ratings and a review, one each per member per book
([#43](../decisions/043-reads-reviews-members-item-keeps.md)), shown with everyone else's on the
book's page. What a shelf, a share page or a connection sees is the household's: the average rating,
rounded to the half star, and the review written last, with no author — unless an admin switches
names on, when each member's rating and review appear under the display name they chose
([members-and-privacy.md](members-and-privacy.md#display-names-and-the-switches)). Taking a rating
or review back is never news to a connection.

## What to read next

The Overview suggests one book you haven't finished and aren't reading, owned or not, whoever else
has read it ([#46](../decisions/046-read-next-suggests-signed-members.md)). **Another** draws a
different one; **Start reading** opens your read and the book.

## Want lists

Each member keeps their own ([#53](../decisions/053-member-has-want-list-household.md)): **Want to
read** on a book's page, **Want** on a record's or a game's, or straight from a scan or search
result — which adds the item as Not owned, or puts the want on the copy already here (a book by
ISBN, a record by barcode or Discogs id, a game by BGG id). **Want list** in the sidebar shows
yours, newest first, and anyone else's in the household. Finishing a book takes it off your list;
stopping one, or someone else finishing it, doesn't. Want to read isn't offered on a book the
household owns and someone has read or is reading. Anyone pastes shop links under **Where to
buy** — a label and an http(s) address, up to twenty an item. A **Wanted** badge shows beside Not
owned while someone wants an item nobody owns, never saying who. An admin can publish a member's
list as a gift list ([sharing.md](sharing.md#gift-lists)).

## Quotes and highlights

On any book's page, keep the lines worth keeping, each with a page or location and a note of your
own ([#77](../decisions/077-quotes-and-highlights.md)). A quote is yours, editable by you or an
admin, and private until you tick **Show on share pages** — then the quote and its page appear
wherever the book is shared, signed with your display name while names are on; the note never
leaves the app. **Reading → Quotes** lists all of yours, and the household picks whose. A book holds
at most 500. **Import your Kindle highlights** under Import / export: `My Clippings.txt` or the
app's notebook export, parsed in your browser, each highlight a quote dated when Kindle recorded
it, with Kindle's note attached; a book not here is added as a Not owned entry, and importing the
same file twice adds nothing ([runbooks/import-from-kindle.md](../../runbooks/import-from-kindle.md)).

## Reading goals

Each member sets how many books they mean to finish this year or next
([#49](../decisions/049-member-can-set-reading-goal.md)); admins can set anyone's. Every finished
read of a book with an end date in the year counts, re-reads included — records, games and undated
finishes don't. The Overview shows your goal as "14 of 24" with a bar and your pace, measured
evenly from 1 January: on pace, behind, ahead, reached. Goals never reach a share page; connected
households hear when one is set, passes halfway and is reached only while both **Show names to
connected households** and **Share reading goals** are on, and only for a member with a display
name. Goals are about people, not items, so they stay out of the CSV; backups carry them.

## Year in review

Pick a year and see your reading beside the household's
([#59](../decisions/059-year-review-page-app-counted.md)): books finished (a re-read counts again)
and pages read, month by month; most-read authors and most-used tags; the average rating given, the
highest-rated, the longest and shortest book and the fastest read; and the household's records spun
and games played, with the most played of each. A book counts in the year it was finished; finishes
with no date count in no year, and the page says how many there are. Inside the app only.

## Finding more to read

Two pages, and that is the extent of discovery, by decision
([#78](../decisions/078-new-from-your-authors.md)): no recommendation engine, no "readers like you",
nothing about your reading sent anywhere.

- **New from your authors** (Reading in the sidebar) lists the authors of the books you've
  finished, most first. **Look up** asks Open Library for an author's works, newest first — one
  request, only when you click — and shows them as Add-page results with what you already have
  marked.
- **Find the missing volumes on Open Library**, on a series' page, lists the works Open Library
  places in the series and offers the numbers you're missing with your series' name and that number
  filled in ([#79](../decisions/079-series-gaps-from-open-library.md)). What you hold isn't offered
  again, and your own names, numbers and total are never changed. Open Library knows series for
  some works and not others, so an empty answer means only that.

## Plays, and game night

**Played** on a board game's or a record's page logs a play today, or any day you pick
([#54](../decisions/054-board-games-records-get-play.md)). The page keeps count — how many times, and
when last — over the recent dates, and **All N plays** lists every one by year. A play is the
household's, not a person's: no players, scores or durations. Whoever logged a play, or an admin,
can remove it. Share pages show only the count; connections see none of it. Plays round-trip
through the CSV.

**What should we play tonight?** — linked from the Overview and from any shelf showing board games
([#60](../decisions/060-what-should-we-play-tonight.md)): say how many players, how much time and
what weight (light, medium or heavy, from BGG's complexity rating), and see the board games you own
and haven't lent that fit, in random order, each with when it was last played — or press **Pick one
for us**. Games missing a detail you asked about are listed under **Not enough details** rather than
hidden; **Refresh from BGG** on each fills it ([cataloguing.md](cataloguing.md#board-games)).
