# §16 #52 — An item can belong to a series: a `series` table, and a series id and number on the item

**Decided:** 2026-09-30 (series). Cited as `ARCH.md §16 #52`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner
asked for "The Expanse, #3" — numbers fractional ("2.5") or missing — filled in when adding, always editable,
with a view of the volumes held, the numbers missing, an optional total, and each member's next volume.
- **A table, not plain columns.** A series has one property of its own, the total, and a name that is
  renamed as a whole; as text on every item, a total would be copied onto each volume and disagree, and a
  rename would rewrite them all. So `series` (name, `key`, total) and `items.series_id` / `series_number`
  (REAL, so 2.5 fits and sorts). The name is unique by `key` — the name NFC-normalised, stripped of control
  and format characters, spaces collapsed, lowercased in JavaScript — because SQLite's `NOCASE` and
  `lower()` fold ASCII only; the first spelling written stays the name. Not book-only: any item may have a
  series, and the form offers it on every type; only book providers fill it. The reference has no
  `ON DELETE` (drizzle-kit drops it on `ALTER TABLE`, §16 #35), so a series is deleted only when nothing
  points at it: `pruneSeries()` rides in the batch of every write that can empty one — an edit that moves
  or clears an item's series, deleting an item, deleting a shelf. Its total goes with it.
- **What the providers return** (checked live on 2026-09-30; responses recorded in
  `test/fixtures/series-responses.ts`). Open Library's search index carries `series_name` and
  `series_position` as parallel lists on many works — The Expanse #3, Discworld #8, Harry Potter, Dune,
  The Kingkiller Chronicle #1, The Witcher at "0.5", and The Lord of the Rings omnibus at "1-3" — and
  nothing on others (A Wizard of Earthsea, The Hobbit, the Expanse novellas). Both of our field lists now
  ask for them; the first series is taken, and a position that isn't one number keeps the series without
  one. Its edition records have a free-text `series` ("The expanse -- bk. 1") that would cost another
  request and a guess; not used. **Google Books never names a series**: `seriesInfo` is absent from nearly
  every volume (The Expanse, in print and as ebooks, and Harry Potter among them); the few that carry it
  (Play Books comics) give a `bookDisplayNumber` and a `seriesId`, and `/books/v1/series/get`, which has the
  name, answers 401 to an API key — it wants OAuth. A number with no series fills nothing, so it's unread.
- **Gaps** are the whole numbers from 1 to the highest held — or to the total, once set and higher — that
  no volume carries. A fractional volume fills no whole number and is never missing itself (nothing says a
  1.5 exists); a number held twice (two editions) counts once; volumes without a number count for nothing
  and are listed last. A volume logged but not owned (`copies = 0`) is in the catalog, so it isn't a gap —
  it shows its "Not owned" badge instead. Computed from the numbers held, linear in them, and long runs
  fold ("#6–40") so a typo can't fill a page.
- **Next up** is the lowest-numbered volume the signed-in member hasn't finished — a finished read of
  theirs (`reads.reader_id`), never the household's status — counting a number finished in any edition,
  and preferring the edition they're reading. Missing numbers between their last finish below it
  (whole numbers only: a finished #2.5 says nothing about #2) and it are named ("#4 comes first —
  not in the catalog"); with every numbered volume finished it points at the
  next missing number, if the series is known to go on. Unnumbered volumes have no place in the order.
- **Where it shows.** A book's page gets a Series section — the numbers as a strip (held, current,
  finished by you, missing), the gaps, next up — for one batch, one D1 call (a page measured 10 calls with
  a series, 9 without). `/series` lists every series (4 calls), `/series/:id` orders the volumes with the
  missing numbers in their places (4 calls) and renames — a name another series already has merges the
  two, the total given, else theirs, else this one's, kept — or sets the total. Any member may, as with any
  catalog edit.
- **Share pages: the name and number only.** They are public catalogue data, like the publisher, so a
  shared item's page shows "Series: The Expanse #3" through `toPublicItem(item, { series })` — the key
  only when the route passes the item's own series row, so listings, connections (`toConnectionItem()`)
  and every other caller serve exactly what they did. The gaps say what the household lacks and next up
  is one member's reading: neither appears, and nothing links to the in-app series pages (§9).
  Connections get nothing new; adding it there is a later, optional protocol field.
- **Portability.** The export gains `series`, `series_number` and `series_total` (repeated per volume);
  a Nalanda re-import restores them, a number or total that isn't one is dropped, and a non-empty total
  sets the series'. libib documents `group` as "what series an item belongs to", so it becomes the series
  — and still a tag, as before, so nothing that relied on the tag changes; libib has no number. Goodreads
  has no series column but its titles carry "(The Dark Tower, #1)" — 94 of production's 1,998 titles did —
  so an added book's suffix becomes its series and leaves the title (the first series of "(Discworld, #8;
  City Watch, #1)"; an omnibus "#1-4" keeps the series, no number). A Goodreads merge never touches
  bibliographic fields (§16 #14), so a book already here keeps its title and gets no series, and matching
  already ignores the suffix, so re-runs still match. The backup exports `series` before `items`.
- **No backfill** (the owner's call): the migration only adds the table and two empty columns, and
  existing items stay blank until edited; the metadata backfill never writes a series. Rehearsed on
  production's backup of 2026-09-29 (0000–0027, the per-table restore in `TABLES` order, then this
  migration): all 29 pre-existing tables identical in every pre-existing column, row for row, 1,998 items
  in no series, foreign-key and integrity checks clean, the search index rebuilt.

**Chosen without asking, overrulable:** gaps count logged-but-not-owned volumes as held; next up may be a
volume not owned, and names missing numbers before it rather than pointing at them; a series with no
volumes left is deleted, total and all; a rename onto a taken name merges rather than refuses; libib's
`group` is kept as a tag too; a Goodreads suffix is stripped from the title of a book the import adds; a
form without the series fields (one opened before this release) leaves the series alone; share listings
and connections don't carry the series; the series field shows for every media type.
