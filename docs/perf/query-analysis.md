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

## Proposals not implemented

These would change output, or the shape of the data, so they are the owner's call:

- **A. Keep each shelf's item count on the shelf.** Even after this work, every signed-in page reads
  about 2,000 rows to count the items on each shelf for the sidebar: the floor of every page, and about
  100,000 rows on the day above.
  - **The change:** a `libraries.item_count` column kept by triggers on `items` (insert, delete,
    `library_id` change).
  - **Saving:** about 2,000 rows a page, on every page.
  - **Cost:** a data migration and backfill, three triggers that every write path (imports, bulk
    moves, cascades) has to keep in step, and one extra row written per item insert or move.
- **B. Break ties in the Overview's "by type" line explicitly.** `holdingsByType` orders by count
  only; ties come out in whatever order the plan produces ("1 vinyl · 1 board game"). An index on
  `media_type` halves its cost (4,001 → 1,999) and makes Play tonight read 2 rows instead of 2,012, but
  turns that line into "1 board game · 1 vinyl".
  - **The change:** add `media_type` as a second sort key, then the index.
  - **Effect:** a visible change on the Overview, only for types with equal counts.
- **C. Year in review in fewer, cheaper statements.** The seven reading statements each rebuild and
  re-scan the year's finishes (about 2,000 rows each on the synthetic household before any grouping).
  - **The change:** one statement that materializes them once and returns every list as tagged rows
    would save roughly another 12,000 rows on the synthetic household. The years picker could
    skip-scan years on the new index instead of reading every dated finish (4,146 → tens).
  - **Cost:** both rewrite §16 #59's batch and its parsing. They are worth it only if the page turns
    out to be visited often.
