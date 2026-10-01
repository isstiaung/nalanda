# D1 query analysis — 2026-10-01

What every main page and htmx partial costs in D1, measured on a copy of production's data, and what
can be cut without changing a byte of what a page shows. ARCH.md §16 #68 records the outcome.

The free plan's scarce resources, in the order they bind for this app:

- **Rows read: 5 million a day.** Every page reads rows; this is the budget a busy day spends.
- **D1 calls per invocation:** designed to 50, measured cap 1,000; a batch is one call (§16 #37).
- **Worker CPU: 10 ms a request.** The queries here return at most a few dozen rows to the Worker,
  apart from the CSV export's 250-item pages, so CPU goes to rendering, not to query results.

## Method

- **Data.** A local copy of the 2026-09-30 production backup (`backups/remote-2026-09-30-3`): 1,999
  items on three shelves, 381 reads, 359 reviews, 1,922 tag links on 41 tags, 303 feed activities,
  one connection with one shared view, three share links. Migrations applied, then each table loaded
  in `scripts/backup.mjs`'s order. Production holds no plays, series or purchase prices yet, so ARCH.md
  §16 #59's synthetic household was measured too: 2,000 items, 1,500 reads, 600 reviews, about 7,000
  tag links and 600 plays.
- **Safety.** Every peer URL was set to `http://127.0.0.1:9` before the app ran, and outbound `fetch`
  was stubbed to answer peers with an empty page and refuse anything else. Nothing left the machine.
- **Measuring.** Each page was requested through the real app (`app.fetch`) inside workerd
  (`@cloudflare/vitest-pool-workers`), signed in as the household's admin. A D1 handle wrapped
  around `env.DB` recorded every call and every statement, with D1's own `meta.rows_read`, which is
  what D1 bills. `first()` and `raw()` return no meta, so each of those reads was run again through
  `all()` to read its count; D1's `first()` runs the whole query, so the count is the same. Work
  handed to `waitUntil`, the background feed and outbox pulls, is counted with its page and shown
  apart. Peer endpoints were called with requests signed by a test key for the connection.
- **Plans.** `EXPLAIN QUERY PLAN` for every statement reading 300 rows or more, from the same data in
  `node:sqlite`, with no `ANALYZE` statistics (D1 doesn't gather any).
- **Output.** Each page's HTML was saved, and two runs of unchanged code compared byte for byte. The
  only differences were the Overview's random "Read next" pick and the test key's fingerprint on
  Connections; both are masked when comparing.

## How D1 counts a row

Measured on the copy (rows read, as `meta.rows_read` reports them):

| Statement | Rows read | Returned |
|---|---:|---:|
| `SELECT * FROM items` | 1,999 | 1,999 |
| `SELECT count(*) FROM items` | 1,999 | 1 |
| `SELECT * FROM items ORDER BY id DESC LIMIT 60` (rowid order) | 60 | 60 |
| `SELECT * FROM items ORDER BY title LIMIT 60` (no index on title) | 3,998 | 60 |
| `SELECT title FROM items WHERE library_id = 1` (index step + table seek) | 1,998 | 1,997 |
| `SELECT library_id, count(*) FROM items GROUP BY library_id` (covering index, in order) | 1,999 | 3 |
| `SELECT media_type, count(*) FROM items GROUP BY media_type` (temp B-tree) | 3,998 | 3 |
| same, with an index on `media_type` | 1,999 | 3 |
| `SELECT * FROM items WHERE library_id = 1 ORDER BY added_at DESC, id DESC LIMIT 60` | 3,995 | 60 |
| same, with an index on `(library_id, added_at)` | 60 | 60 |

So every step of a cursor counts once, and an index step with its table seek counts once. Every row
that passes through a temporary B-tree (`USE TEMP B-TREE FOR ORDER BY / GROUP BY / DISTINCT`) counts
**again**, even under `LIMIT 1`. A count is never free: `count(*)` reads every row it counts. The
levers are therefore an index that delivers rows already in order, so no sorter runs and a `LIMIT` stops early;
an index that finds rows without a scan; and not running the same aggregate twice.

## Pages, as they were

Production's data, signed in as the admin. *Calls* are D1 calls (a batch is one); *bg* is work the page
hands to `waitUntil`. *Rows* is everything the request read, background included.

| Page | Path | Calls | Rows read | Worst statement — rows |
|---|---|---:|---:|---|
| Overview | `/` | 13 | 22,397 | holdings by type (`holdingsByType`) — 4,001 |
| Overview: "Another" (htmx) | `/?not=1` | 2 | 3,997 | Read next pick (`pickNextRead`) — 3,996 |
| Shelf | `/libraries/1` | 14 | 16,483 | page of items, newest first (`listItems`) — 3,995 |
| Shelf (htmx) | `/libraries/1` | 14 | 16,483 | page of items, newest first — 3,995 |
| Shelf, page 10 | `/libraries/1?page=10` | 14 | 16,649 | page of items, newest first — 3,995 |
| Shelf, Completed | `?status=completed` | 14 | 15,075 | shelf totals by type (`shelfTotals`) — 3,995 |
| Shelf, In progress | `?status=in_progress` | 14 | 14,064 | shelf totals by type — 3,995 |
| Shelf, Books | `?type=book` | 14 | 16,483 | page of items, newest first — 3,995 |
| Shelf, Owned | `?owned=1` | 14 | 14,850 | shelf totals by type — 3,995 |
| Shelf, by title | `?sort=title` | 14 | 16,594 | page of items, by title — 3,995 |
| Shelf, by rating | `?sort=rating` | 14 | 16,795 | page of items, by rating — 3,995 |
| Shelf, by completed | `?sort=completed` | 14 | 16,668 | page of items, by completed — 3,995 |
| Shelf, searched | `?q=history` | 14 | 14,664 | shelf totals by type — 3,995 |
| Shelf, Read by me | `?readBy=me` | 14 | 15,837 | shelf totals by type — 3,995 |
| Shelf, covers | `?view=grid` | 13 | 16,370 | page of items, newest first — 3,995 |
| Shelf, covers, Completed by title | `?view=grid&status=completed&sort=title` | 13 | 14,748 | shelf totals by type — 3,995 |
| Tags | `/tags` | 5 | 5,976 | tag counts (`listTagsWithCounts`) — 3,966 |
| A tag | `/tags/reviewed-books` | 8 | 11,197 | tag filter (correlated `EXISTS`) — 4,550 |
| Item: book | `/items/2` | 14 | 2,046 | sidebar shelf counts (`listLibraries`) — 1,999 |
| Item: book, edit | `/items/2/edit` | 12 | 4,039 | sidebar shelf counts — 1,999 |
| Item: game | `/items/2000` | 14 | 2,030 | sidebar shelf counts — 1,999 |
| Item: record | `/items/1980` | 14 | 2,030 | sidebar shelf counts — 1,999 |
| Search | `/search?q=history` | 10 | 4,466 | sidebar shelf counts — 1,999 |
| Search, empty | `/search` | 5 | 2,012 | sidebar shelf counts — 1,999 |
| Year in review, this year | `/year-in-review` | 5 | 5,905 | sidebar shelf counts — 1,999 |
| Year in review, 2024 | `?year=2024` | 5 | 6,762 | sidebar shelf counts — 1,999 |
| Play tonight | `/play` | 5 | 4,022 | games for tonight (`gamesForTonight`) — 2,012 |
| Play tonight, filtered | `/play?players=4&time=60` | 5 | 4,022 | games for tonight — 2,012 |
| Series | `/series` | 5 | 2,012 | sidebar shelf counts — 1,999 |
| Wants | `/wants` | 10 | 6,024 | want-list filter (correlated `EXISTS`) — 2,002 |
| Goals | `/goals` | 8 | 2,396 | sidebar shelf counts — 1,999 |
| Loans | `/loans` | 9 + 5 bg | 2,022 | sidebar shelf counts — 1,999 |
| Borrowed | `/borrowed` | 8 + 2 bg | 2,020 | sidebar shelf counts — 1,999 |
| Feed | `/feed` | 11 + 9 bg | 2,071 | sidebar shelf counts — 1,999 |
| Notifications | `/notifications` | 7 | 2,013 | sidebar shelf counts — 1,999 |
| Recommendations | `/recommendations` | 9 + 2 bg | 4,021 | sidebar shelf counts — 1,999 |
| Connections | `/connections` | 13 | 6,024 | sidebar shelf counts — 1,999 |
| Shares (admin) | `/shares` | 9 | 14,344 | tag filter (correlated `EXISTS`) — 4,274 |
| Members | `/settings/users` | 6 | 2,013 | sidebar shelf counts — 1,999 |
| Account | `/account` | 5 | 2,011 | sidebar shelf counts — 1,999 |
| Add | `/add` | 9 | 4,019 | sidebar shelf counts — 1,999 |
| Import | `/import` | 7 | 6,014 | backfill status (`countBackfillable`) — 1,999 |
| Export, one page | `/export.csv?after=0` | 5 | 3,702 | sidebar shelf counts — 1,999 |
| Share page (a shelf) | `/share/:token` | 3 | 4,313 | page of items, newest first — 2,314 |
| Share page, page 2 | `/share/:token?page=2` | 3 | 4,313 | page of items, newest first — 2,314 |
| Share page (a tag) | `/share/:token` | 4 | 8,954 | tag filter (correlated `EXISTS`) — 4,550 |
| Share item page | `/share/:token/items/:id` | 6 | 4 | the share — 1 |
| Peer: views | `GET /federation/views` | 4 | 2,792 | view sizes (`describeViews`) — 1,998 |
| Peer: feed pull, from start (names on) | `GET /federation/feed?since=0` | 5 | 26 | per-person stream — 22 |
| Peer: feed pull, cursor (names on) | `GET /federation/feed?since=…` | 5 | 26 | per-person stream — 22 |
| Peer: removal check (names on) | `POST /federation/feed/check` | 4 | 29 | per-person stream — 26 |
| Peer: shelf | `GET /federation/shelf` | 6 | 4,016 | page of items, by title — 2,002 |
| Peer: item | `GET /federation/item` | 7 | 11 | the item's tags — 4 |
| Peer: outbox | `GET /federation/outbox` | 3 | 3 | — |
| Peer: feed pull, from start (names off) | `GET /federation/feed?since=0` | 5 | 4,435 | household stream (`activityInView`) — 4,431 |
| Peer: feed pull, cursor (names off) | `GET /federation/feed?since=1` | 5 | 799 | household stream — 795 |
| Peer: removal check, 303 ids (names off) | `POST /federation/feed/check` | 4 | 1,403 | household stream — 1,400 |

The most calls any page made was 14 (shelves, item pages), and Feed's 11 plus 9 in the background:
well inside the budget of 50. No page returned more than a few hundred rows to the Worker except the export
page (741 rows of cells for 250 items, as designed in §16 #38).

On the synthetic household the same pages cost about the same, apart from the ones that scale with
reads, tags and plays: Year in review for 2024 read **54,918** rows (ARCH.md §16 #59 measured about
52,000), this year's 18,253; Tags 16,012; Play tonight 5,690.

## Findings, ranked

Ranked by what they cost a realistic day (next section). Savings per view are measured on the copy,
with the index or rewrite in place, unless marked as an estimate.

1. **The sidebar's shelf counts run twice on most pages, as two calls each.** `listLibraries` is two
   statements: the shelves, then `SELECT library_id, count(*) FROM items GROUP BY library_id`, a scan of
   every item (1,999 rows). The layout runs it on every signed-in page, and the Overview, shelves, item
   edit, Add, Search, Shares, Import, Recommendations and Connections run it again for their own use.
   - **Fix:** one statement, and let a page hand the list it already has to the layout.
   - **Saving:** 1 call on every signed-in page; on the pages that list shelves themselves, another
     call and 2,005 rows.
   - **Left over:** about 2,000 rows a page for the sidebar remains the floor of every signed-in page
     (proposal A).
2. **The Overview reads 22,397 rows.**
   - `recentItems` sorts every item to show 12: 4,000 rows. An index on `added_at` makes it 13.
   - `pickNextRead` sorts every candidate book to keep one: 3,996 rows. Keeping the least random key in
     one pass reads 2,377.
   - `shelfTotals` sorts to group by shelf and type: 3,998 rows. An index on `(library_id, media_type)`
     makes it 1,999.
   - The paid totals scan every item to find the priced ones (none yet): 2,000 rows. A partial index
     on priced items makes it the number of priced items.
   - `holdingsByType` sorts to group by type: 4,001 rows. An index fixes that too, but it reorders two
     types with equal counts on the page; see proposal B.
   - Together with finding 1, these come to an estimated 22,397 → about 6,400.
3. **A shelf reads every item on it twice to show 60.**
   - The page of items is `ORDER BY added_at DESC, id DESC` (or `title`) with no index to deliver
     that order: 3,995 rows.
     - **Fix:** indexes on `(library_id, added_at)` and `(library_id, title)`.
     - **Saving:** 60 rows on the first page, about 600 on page 10. This applies to every shelf view,
       the covers view, share pages of a shelf (2,314 → about 60) and a peer's shelf.
   - The shelf's totals by type cost another 3,995 (finding 2's index makes it 1,998), and the paid
     totals 1,999 (the partial index makes it 0).
   - On an unfiltered shelf, the count of its items (1,998 rows) repeats the sidebar's count of the
     same shelf, which the page already has.
   - Together: 16,483 → an estimated 4,500 for the default shelf view.
4. **Tag filters scan every item.** A tag's page, a share link that captured a tag, and the Shares
   page's counts filter with `EXISTS (SELECT 1 FROM item_tags JOIN tags … WHERE item_id = items.id
   AND name = ?)`. SQLite runs that once per item, `SCAN items`: 4,274 rows to count a tag's 276 items
   and 4,550 to list 60 of them.
   - **Fix:** written as `items.id IN (SELECT item_id FROM item_tags JOIN tags … WHERE name = ?)`, the
     same set, with an index on `item_tags(tag_id)`. SQLite then starts from the tag: 829 rows to
     count and 1,105 to list.
   - **Saving:** a tag page 11,197 → about 4,000; a tag's share page 8,954 → about 2,000. The Tags
     page builds a temporary index over `item_tags` on every view (3,966 rows); the same index makes
     that about 2,000.
5. **Want lists scan every item the same way.** The Wants page and gift lists filter with
   `EXISTS (SELECT 1 FROM wants WHERE item_id = items.id AND user_id = ?)`: 2,000 rows to count one
   want.
   - **Fix:** as `IN` over the wants table's primary key: 3 rows.
   - **The shelf's "Read by" filter:** "Being read by me" goes from 2,002 to 16 the same way, and
     "Read by me" from 2,379 to 1,506. "Not read by me" stays `NOT EXISTS`.
6. **Year in review.** Each of its seven reading statements rebuilds the year's finishes from a scan of
   `reads`.
   - **Fix:** an index on `reads(status, ended_on)` makes that build a range of the year's finishes.
   - **Saving:** 2024 on production's data 6,762 → 3,813; on the synthetic household 54,918 →
     46,461, and this year's 18,253 → 6,261. The count of undated finishes drops from 1,532 to 63.
   - **Left over:** the rest is each statement's own grouping and windows over the year's finishes,
     about 2,000–10,000 rows apiece on the synthetic household. Cutting that means restructuring the
     batch (proposal C).
7. **Play tonight** scans every item for the board games (2,012 rows; an index on `media_type` makes
   it 2). The same index reorders the Overview's tied counts (proposal B), so it isn't added.
8. **Connections cost little.**
   - With names to connections on, as production has them, a peer's hourly pull and removal check
     read 26 and 29 rows.
   - With names off, a first pull from the start reads 4,431. Pulls after that read what's new since
     the cursor, and a removal check of 303 ids reads 1,400. Peers pull every 60 minutes at most, and
     a first pull happens once.
   - `/federation/views` (2,792) is cached per isolate.
   - Nothing here needs changing.
9. **Rarely visited, left as they are:**
   - Import's backfill counts: 6,014.
   - An export page: 3,702, so about 30,000 for a whole 2,000-item export.
   - The Shares admin page: 14,344, which the tag fix brings to about 6,000.

## A realistic day

Fifty signed-in page views a day, mixed:

| Views | Page |
|---:|---|
| 10 | Overview |
| 2 | "Another" (Read next) |
| 15 | Shelf views, of which 2 by title, 2 as covers, 1 page 10, 1 filtered, 1 searched, 2 htmx |
| 11 | Item pages: 8 books, 1 game, 1 record, 1 edit |
| 3 | Search |
| 2 | A tag |
| 2 | Feed |
| 1 each | Loans, Wants, Goals, Year in review, Play tonight, Add |

Plus six share-link visits (three shelf, one tag, two items) and one connected household pulling one
view hourly (24 pulls and 24 removal checks).

| | Rows read a day | Of 5M |
|---|---:|---:|
| Production's data, before | **589,000** | 11.8% |
| Synthetic household, before (no peers) | 611,000 | 12.2% |

The Overview is 38% of the day (10 × 22,397), shelves 41%. The free plan would take about eight such
days a day; it's nowhere near binding, but the cost is concentrated in a few pages that are easy to fix.

## What changed, and what it saved

Implemented in the commits after this report; ARCH.md §16 #68 records the decision.

| Change | Where it saves (production's data, per view) |
|---|---|
| **Migration 0040**, seven indexes: `items (library_id, added_at)`, `(library_id, title)`, `(added_at)`, `(library_id, media_type)`, partial `idx_items_paid` (priced items only), `item_tags (tag_id)`, `reads (status, ended_on)` | a shelf's page of items 3,995 → 60; recent items 4,000 → 13; totals by type 3,995 → 1,998; paid totals 2,000 → 0; a year's finishes become a range |
| `listLibraries()` is one statement, and a page that read it hands it to `page()` | 1 call on every signed-in page; 2,005 rows + 2 calls on Add, Search, Shares, Import, Recommendations, Connections, item edit |
| `shelvesWithTotals()`: shelves, counts, totals and holdings by type in one batch, one pass | Overview −8,000 rows and −3 calls; shelf −2,000 and −1 |
| An unfiltered shelf takes its count from the shelves' (`listItems(…, knownTotal)`) | 1,998 rows + 1 call per unfiltered shelf view |
| Tag, want-list and Read-by filters as `IN`, not correlated `EXISTS` | a tag page 11,197 → 4,309; a tag's share page 8,954 → 2,064; Wants 6,024 → 2,032; a gift list 4,007 → 13 |
| "Read next" keeps the least random key with `min()`, no sort | 3,996 → 2,377, on the Overview and every "Another" |
| Year in review: the picker's years by index skip-scan; tags grouped by id before their names | years 770 → ~30 (synthetic 4,146 → 36); tags −2,300 synthetic |

### Pages, before → after

Production's data. HTML byte-identical on all 66 measured pages, with the random "Read next" card and the
test key's fingerprint on Connections masked; the synthetic household's pages too, apart from Play tonight's
random 60 and the export's seeding timestamps, which differ between two runs of unchanged code as well.

| Page | Calls | Rows read | Saved |
|---|---:|---:|---:|
| Overview | 13 → 8 | 22,397 → 4,785 | 79% |
| Overview: "Another" | 2 → 2 | 3,997 → 2,378 | 41% |
| Shelf (default, htmx alike) | 14 → 8 | 16,483 → 2,551 | 85% |
| Shelf, by title | 14 → 8 | 16,594 → 2,662 | 84% |
| Shelf, covers | 13 → 7 | 16,370 → 2,438 | 85% |
| Shelf, page 10 | 14 → 8 | 16,649 → 3,257 | 80% |
| Shelf, Completed | 14 → 9 | 15,075 → 4,910 | 67% |
| Shelf, by rating | 14 → 8 | 16,795 → 6,798 | 60% |
| Shelf, Read by me / being read by me | 14 → 9 | 15,837 / 14,072 → 4,796 / 4,082 | 70% |
| Tags | 5 → 4 | 5,976 → 4,056 | 32% |
| A tag | 8 → 7 | 11,197 → 4,309 | 62% |
| Item page (book, game, record) | 14 → 13 | 2,046 → 2,048 | — |
| Item edit | 12 → 9 | 4,039 → 2,036 | 50% |
| Search | 10 → 7 | 4,466 → 2,463 | 45% |
| Year in review, 2024 | 5 → 4 | 6,762 → 3,171 | 53% |
| Year in review, 2024 (synthetic) | 4 → 3 | 54,918 → 40,064 | 27% |
| Year in review, this year (synthetic) | 4 → 3 | 18,253 → 2,151 | 88% |
| Wants | 10 → 9 | 6,024 → 2,032 | 66% |
| Shares (admin) | 9 → 6 | 14,344 → 5,010 | 65% |
| Add / Import / Recommendations | 9 / 7 / 9 → 6 / 4 / 6 | about 2,000 less each | 33–50% |
| Share page (a shelf) | 3 → 3 | 4,313 → 3,740 | 13% |
| Share page (a tag) | 4 → 4 | 8,954 → 2,064 | 77% |
| Share page (a gift list) | 4 → 4 | 4,007 → 13 | 100% |
| Every other signed-in page | one call fewer | about the same | — |
| Peer endpoints | unchanged | unchanged | — |

The shelf's share page saves least: it lists owned books newest first, and owned books are the older ones, so
the index walk passes 1,700 newer unowned items before it has 60. That is still cheaper than sorting the shelf.

### A realistic day, after

| | Before | After | Of 5M |
|---|---:|---:|---:|
| Production's data | 589,000 | **170,000** | 11.8% → 3.4% |
| Synthetic household (no peers) | 611,000 | 208,000 | 12.2% → 4.2% |

The Overview is still the largest share (10 × 4,785), then item pages, whose 2,048 rows are almost all the
sidebar's shelf counts (proposal A).

### Writes and the migration

- **Writes:** the indexes are written with every row they cover. An item insert now writes 9 rows instead of 5,
  a tag link 3 instead of 2, a read 4 instead of 3, and a title edit 4 instead of 3. A 2,000-item import writes
  about 8,000 more rows of the 100,000 a day.
- **Building them** on production's data writes about 10,300 rows once and reads about 22,700.
- **Rehearsed** on another local copy of the backup, with wrangler's local D1 in its own `--persist-to` state:
  migrations 0000–0039 applied, the backup loaded in `scripts/backup.mjs`'s order, every table snapshotted,
  0040 applied, then snapshotted again.
  - All 40 of the app's tables are identical, row for row.
  - The schema gained exactly the seven indexes, and nothing else changed or went.
  - `PRAGMA integrity_check` is ok and `foreign_key_check` clean, before and after.
  - Only bookkeeping moved: `d1_migrations` gained 0040's row, its `sqlite_sequence` entry went from 40 to 41,
    and D1's own `_cf_METADATA` counter changed.

### Guarding it

`test/query-cost.spec.ts` holds the busiest pages to a rows-read budget per catalogue item on a 2,000-item
household, measured with D1's own `rows_read`. Every budget sits under what the page read before, measured on
the same household:

| Page | Before | Budget | Now |
|---|---:|---:|---:|
| Overview | 11.0 | 3 | 2.2 |
| A shelf | 8.2 | 2 | 1.2 |
| A tag | 5.6 | 3 | 2.2 |
| Wants | 3.0 | 1.5 | 1.0 |
| A shelf's share page | 2.5 | 1.5 | 1.05 |

New tests also check that the years skip-scan lists exactly what the old query did, odd dates included, and
that the Overview's holdings equal `holdingsByType()`'s, ties included.

## Proposals not implemented

- **A. Keep each shelf's item count on the shelf.** Every signed-in page still reads about 2,000 rows to count
  the items on each shelf for the sidebar. It is now the floor of every page, and about 100,000 rows of the
  170,000 day.
  - **The change:** a `libraries.item_count` column kept by triggers on `items` (insert, delete, `library_id`
    change).
  - **Saving:** about 2,000 rows a page.
  - **Why not now:** it changes the shape of the data. It needs a data migration with a backfill, and triggers
    every write path has to keep in step. A restore would double every count: the backup carries
    `item_count`, and the items inserted after it fire the triggers. So the backup runbook would need a
    recount step. Owner's call.
- **B. (Done another way.)** The Overview's "by type" line had no explicit tiebreak. Its current order turned out
  to be exactly descending type order for every pattern of ties, so that order is now written into
  `holdingsByType()`. The Overview reads the same from the shared pass, with no index on `media_type`.
  - **Still possible:** an index on `media_type` would make Play tonight read 2 rows instead of 2,012, at one
    more row written per item insert. Left out as a rare page.
- **C. Year in review in one statement.** The seven reading statements each rebuild and re-scan the year's
  finishes. One statement sharing one materialization would save about 6,000 more rows on the synthetic
  household, and next to nothing on production's data, whose year holds a dozen finishes. Not worth rewriting
  §16 #59's batch and its parsing.
- **D. Count a goal's year by range.** `goalCountSql()` compares `CAST(substr(ended_on, 1, 4) AS INTEGER)`, which
  no index serves: 379 rows on the Overview and Goals today, growing with reads. A range would use
  `idx_reads_status_ended`, but it counts malformed dates differently ("2024" alone), and migration 0036's
  triggers carry that expression word for word. That would be a change in what counts.
- **E. Smaller things, left alone:**
  - Filtered shelf views still count their matches (about 2,000 rows); indexes for every filter would cost
    writes for rare views.
  - The layout's unread counts could share the sidebar's batch, saving one call a page; calls are far from the
    budget.
  - Peer endpoints are cheap, and `/federation/views` is cached.
