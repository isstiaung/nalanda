# §16 #68 — Rows read are budgeted like calls: pages read in index order, count once, and filter from the small side

**Decided:** 2026-10-01 (what the pages read). Cited as `ARCH.md §16 #68`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner asked for a query analysis (docs/perf/query-analysis.md). Every page and partial was requested through
the app in workerd on a copy of production's data (1,999 items) and on #59's synthetic household, with D1's own
`rows_read` per statement, and every page's HTML compared byte for byte before and after.
**How D1 counts:** every cursor step is a row, an index step with its table seek is one, and every row that
passes a temporary B-tree counts again, even under `LIMIT 1`. So a page of 60 sorted from 2,000 read 4,000, and
a `count(*)` reads every row it counts.
**What was spent:** the Overview read 22,397 rows and a shelf 16,483 to show a few dozen items; a realistic day
(50 signed-in views, six share visits, a peer's hourly pull) was 589,000 of the 5 million — never near the
limit, but concentrated in a few fixable statements.
**What changed:**
- Migration 0040 adds seven indexes, nothing else: `items (library_id, added_at)`, `(library_id, title)`,
  `(added_at)` and `(library_id, media_type)`, a partial `idx_items_paid` on priced items,
  `item_tags (tag_id)` and `reads (status, ended_on)`.
- The sidebar's shelves and counts are one statement, and a page that read them hands them to `page()`.
- The Overview and a shelf read the shelves, their totals and the holdings by type in one batch, one pass over
  the items (`shelvesWithTotals()`). An unfiltered shelf takes its count from it (`listItems(…, knownTotal)`).
- Tag, want-list and Read-by filters are `IN` rather than a correlated `EXISTS`: the same set, found from the
  tag, the wants or the reads.
- "Read next" keeps its pick with `min()` over a random key in one pass, not a sort.
- Year in review: as #59 now says.

The day is now 170,000 rows; the Overview reads 4,785 and a shelf 2,551, in 7–8 calls instead of 13–14.
`test/query-cost.spec.ts` holds the busiest pages to a rows-per-item budget, as call counts are held.
**Output is unchanged** (66 pages compared; the random "Read next" card aside). Three things had to be
proved first:
- `ORDER BY title` alone leaves ties to the plan, and the new indexes keep 15 duplicated titles in the same
  order.
- `holdingsByType()`'s ties are in descending type order: checked for every pattern of ties among the seven
  types on workerd's SQLite and node's, now written into its `ORDER BY`.
- The years skip-scan lists exactly what the old `UNION` did, junk dates included (a test runs the old query
  as its oracle).

**Writes:** an item insert writes 9 rows instead of 5, a tag link 3 instead of 2, a read 4 instead of 3. A
2,000-item import writes about 8,000 more of the 100,000 a day. Building the indexes on production's data writes
about 10,300 once.
**Not done — they would change what a page or the data is:**
- Each shelf's item count kept on the shelf by triggers. This is about 2,000 rows a signed-in page, now the
  floor of every page. It needs a data migration, and a restore would double the counts unless the backup
  runbook recounts.
- Counting a goal's year by range. `goalCountSql()` matches malformed dates the range wouldn't, and the
  triggers carry it word for word.

**Not done — little to gain for the rewrite:** Year in review's seven reading statements as one statement
sharing one materialization (about 6,000 rows on the synthetic household, nothing on production's).
