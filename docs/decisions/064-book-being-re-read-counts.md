# §16 #64 — A book being re-read counts as In progress, in every status filter, and still as Completed

**Decided:** 2026-09-30 (a re-read counts as In progress). Cited as `ARCH.md §16 #64`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner reported three books being read, one of them a re-read, and only two under Status =
In progress: #41 kept a re-read Completed "so nothing moves between status-filtered views", and
#43 carried that to a member's first read of a book someone else had finished. **The owner
decided: "Yes, everywhere"** — In progress lists every book someone is reading now, on a
shelf (with or without its search box; /search has no status filter), in share links and in
connection views, and a re-read still
also counts as Completed, because someone finished it. Share pages already treated a re-read
as being read now for progress (#41, `toPublicItem(item, { progress })`); the filters now
agree with them. What was decided:
- **The rule is the filter's, not the column's.** `items.status` keeps #41's meaning — the last
  finish decides it — and no migration, trigger or stored value changes. `matchesStatus()`
  (src/lib/reads.ts) says an item matches In progress when `status = 'in_progress'` or
  `rereading = 1`, and any other status by the column; `statusWhere()` (src/db/queries.ts) is
  its SQL twin. Ticking both In progress and Completed lists a re-read once.
- **Where it means "being read now".** Every place a Status filter or a view's captured status
  decides what's inside: `itemFilterWhere` (so `listItems` — the shelf, its item count,
  `shelfPage` — and `countMatchingItems[Many]`, the Shared links page's counts);
  `shareFilters()`/`itemMatchesShare()`; a connection view's `inView()` (feed, removal
  check, `countItemsInView`, `describeViews`' size and volume) and `itemMatchesView()` (the
  item route, `itemIsShared`); and the raw-SQL view tests `sharedItem`, `sharedReviewedItem`
  and `HOLDING_VIEW` (comments, borrowing, recommendations). `toPublicItem`'s "reading now"
  for progress uses `matchesStatus()` too. Tests hold the twins together for every status.
- **Where it stays the column.** `refreshReadState()` and `summarizeReads()`, the edit form's
  status, the activity triggers (a finish is recorded when `status`/`completed_on` change,
  #40), `stillShows`' "a finish needs a Completed book", the export's `status`, and the
  "Read by" filter, which reads `reads` directly (#43). No figure counts items by status:
  the Overview, Year in review (#59) and series pages count reads.
- **The status pill says "Re-reading" in place of "Completed"** — the shelf table and the
  item page (`StatusPills`) — so a re-read in an In progress list doesn't look finished;
  shelf cards already carried the pill alone. It is not public: `toPublicItem()` and
  `toConnectionItem()` have no status or `rereading` key, and none was added. What a
  published In progress view says about a re-read — that someone in the household is reading
  it now — is what it has always said about a first read, and was already inferable: from
  its page on a share page with progress switched on (#41), and from a progress entry's
  `readCount` in a connection's Feed, which says "re-reading".
- **A view filtered to In progress carries only reading that is still going on**
  (`readingInView()` in src/db/federation.ts, in both streams, for the feed, a new follower's
  first page, the removal check and the volume figures). Before, a book was in such a view only
  while nobody had finished it, so a finish took the book, and every entry about it, out. Now a
  book stays in while anyone is reading it, so the view keeps the rule per read:
  - **no finish, nor a goal milestone** (#49), which is one. A book finished before enters the
    view when a re-read starts, and its earlier finish — recorded while the book was outside,
    under an id past a follower's cursor — would have reached followers as news that day, and
    opened a new follower's first page. So would a member's milestone: Asha finishes X and
    reaches her goal, Ravi starts his first read of X, and X is in the view with the milestone
    as its entry. On the backup of 2026-09-30 the household's one In progress connection view
    (books, one shelf) goes from 2 books to 4, and one of the two re-reads has such a finish
    in the log;
  - **a start or a page only while its read is open.** Two people reading one book: Asha
    re-reading X, Ravi on his first read; when Ravi finishes (or stops), X stays in the view
    because Asha is still reading it, but his `started` entry and his pages — per-person or,
    with names off, the household's progress entries — are withdrawn at the next removal check
    and left off new followers' pages. Asha's stay until her read closes. That is what a first
    read always got: its finish took the book, and so its start and pages, out of the view. A
    page with no read (from before reads, #41) stays with its book.
- **Entering or leaving a view is silent.** Starting a re-read records nothing in the
  household's stream (#41), and one `started` entry, as ever, in the per-person stream (#45);
  its pages are progress entries. Finishing it records a finish (completed_on moves, #41), which
  the view doesn't carry, and its start and pages are withdrawn as its read closes, whether the
  book then leaves the view (the last reader) or stays (someone else still reading). Stopping
  it likewise. A Completed view is untouched. An entry of a kind the view does carry, recorded
  while the book was outside — a rating, a review — arrives when it enters, dated when it
  happened (#40), as it does for any book entering any view (a first read started after
  rating it, an Owned toggle, a move between shelves); left as it is.
- **Sorted by date completed**, an In progress share link or view lists its re-reads first,
  by their last finish: that shows the order of past finishes, never their dates. Accepted —
  a view filtered to Completed shows far more.
- **Older peers.** A connected household reads our views' lists and feed from us, so one on
  1.6.0 sees our In progress views include re-reads with nothing to update; its own In progress
  views keep the old meaning until it upgrades. Nothing new goes over the wire.
- **Cost.** An OR in the same statement, and the per-read rule is subqueries inside the feed's
  own statements: no D1 call. Tests pin the shelf page for every status, and a feed pull plus a
  removal check on an In progress view at a Completed view's calls.

**Chosen without asking, overrulable:** the pill replaces "Completed" rather than sitting
beside it (as #41 had it); an In progress view carries no finishes or milestones, and a
reader's start and pages only while their read is open; a rating or review recorded while a
book was outside a view still arrives when it enters.
