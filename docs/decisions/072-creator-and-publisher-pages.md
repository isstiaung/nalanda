# §16 #72 — Creators and publishers are pages: authors, designers and artists read out of `creators`, publishers and labels out of `publisher`, no table

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #72`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Tags and Series each had an index and a page; the people behind the items had neither.
"Everything by Le Guin in the house, and which I've read" is a basic view of a reading log,
and "everything on this label" of a record collection. **The owner asked** for author pages,
artist pages, designer pages and publisher pages, built alike, each for the shelves its kind
lives on.

**What was decided:**
- **No table.** A creator is a name in the `creators` column, a publisher a name in
  `publisher`; the pages are built from those strings. A `creators` table would need a
  migration that splits every row, a join on every shelf query (#68 budgets rows read), an
  import mapping (#38's rule that a column isn't done until the CSV carries it), and a way to
  edit that the item form already is. Nothing is gained that the strings don't give.
- **One split rule.** `splitCreators()` in `src/lib/creators.ts` is the TypeScript twin of
  `YEAR_CREATORS`, the SQL that gives Year in review its most-read authors (#59): ", ", ";"
  and " & " separate people; "Last, First" with given names after the comma is one person
  turned round ("Le Guin, Ursula K." is Ursula K. Le Guin); a suffix keeps its order and a lone
  "Jr." is nobody. Trimming is SQLite's `trim()`, spaces only, so a tab or a no-break space
  stays part of a name in both. `test/creators.spec.ts` runs the same cases through both and
  holds them to the same answers, so the two can't drift.
- **Four pages, two kinds.** `/creators` and `/creators/:name`, `/publishers` and
  `/publishers/:name` (`src/routes/creators.tsx`, one handler pair for both). The index lists
  every name grouped by what it mostly is — Authors, Designers, Artists; Publishers, Labels —
  by the kind of item it has most of, ties in a fixed order (books first), with counts by kind
  and a box to narrow the list by name. A name's page lists its items as a shelf shows them
  (`ItemGrid`, the Wanted and On loan badges), sixty a page, headed by its role and what the
  signed-in member has finished of them. Names compare without case and with whitespace
  collapsed; the first spelling seen is the one shown.
- **An item's page links each person and the publisher** to their page (`CreatorLinks`,
  `src/views/creators.tsx`): the string as written, with each name linked in place when it
  appears verbatim, else the string followed by one link per person ("Le Guin, Ursula K."
  links Ursula K. Le Guin).
- **In the app only.** Share pages show creators and publishers as text, as before; nothing
  here reaches `toPublicItem()` or a connection. The sidebar's Library section links both
  indexes.
- **What it reads.** The creators index reads one row per item with creators, once per visit
  — 2,000 rows on a 2,000-item catalogue, split in TypeScript. The publishers index groups in
  SQL. A name's page narrows in SQL (`instr` on the name's last word, when that word is plain ASCII — SQLite's `lower()`
  folds nothing else, so "Jens Østergaard" reads every row with creators instead; an exact
  publisher) and keeps, in TypeScript, the rows whose split names it exactly: "Ann Leckie" is
  not on "Ann Leckie Jr."'s page.

**What it rules out:** a creators table (above); linking creators on shelf cards and search
rows (the item page is where a name is read; a card is a cover and a title); editing a
creator's name across items from their page (that is the bulk edit's shape, #47, and a
rename of a person is a rename on each item).
