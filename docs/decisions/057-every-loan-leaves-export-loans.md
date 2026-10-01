# §16 #57 — Every loan leaves in the export, in a `loans` cell per item, and a Nalanda import brings it back

**Decided:** 2026-09-30 (loans in the export). Cited as `ARCH.md §16 #57`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Loans are on item pages and the Loans page, but `/export.csv` had no column for
them, so a restore from the file lost every loan, including who has a book now. **The owner
chose a `loans` column** on each item's row (after `copies`), holding every loan of the item,
open and returned, written the way the `reads` cell is (#41, #43):

```
loans  = [loan *(";" loan)]                    in the order they were made (by id), oldest first
loan   = loaned ".." [returned] "@" borrower *("|" part)
part   = "due:" date / "contact:" text / "note:" text    written in this order, read in any
```

For example `2024-03-01..2024-03-20@Asha|due:2024-03-15;2026-09-10..@Ravi%20(Riverbank%20library)|contact:ravi%40example.com`.
Nothing after `..` is a loan still out. Dates are calendar dates. The borrower, contact and
note are percent-encoded (`encodeURIComponent`), as a reader's name is, so `;`, `|`, `@`, `:`,
`%`, commas, quotes, newlines and any script arrive encoded and nothing in the cell needs CSV
quoting. The due date is encoded too, since the item page's lend form stored whatever it was
sent (it now keeps only a calendar date, as a connection's lend already did). Reading is
lenient, as with reads: a part that doesn't parse is dropped and the rest kept — one with no
borrower, a lending date that isn't a date, or a return date that is there but isn't one
(read as still out, it would say someone has a book that came back). A due date comes back as
written, even one that isn't a date — loans lent before the form checked can hold free text,
and the export carries it, so it round-trips (bounded to 200 characters; found by
nalanda-review); an unknown `|key:` part, from a later version, is ignored; a `%` that isn't
our encoding is taken as typed. Written in id order and inserted back in the same order, the
loans keep their relative ids, so every in-app ordering (the Loans page by id, the item page
by date then id) comes back as it was. `src/lib/loans.ts` holds the grammar;
`loansForIdRange()` reads a page's loans and `importItems()` writes a row's back, one
`INSERT … SELECT … FROM json_each` right after the row's item, in the import's batch (#39).
Older exports have no column and import unchanged, with no loans. No migration.

**Loans to connected households** are ordinary loans linked through `connection_loans`
(#29): they export under the borrower they were lent to — "member (household)" — and come
back as local loans. The link can't be rebuilt from a file (the connection, its request and
keys aren't in it), so returning an imported one tells the household nothing: 0010's trigger
needs the link.

**Decided, and why:**
- **Re-import.** A Nalanda import adds every row as a new item and never merges — the preview
  has always said that importing the same export twice adds everything twice. Loans go only
  onto the item their row makes, in the same batch, never onto an item already here, so an
  import can't give any item a loan twice. Importing a file twice gives two copies of each
  item, each with the file's loans, as each gets the file's reads, reviews and tags; deleting
  the extra copy takes its loans with it. A match on (item, borrower, loaned_on) was weighed
  and left out: the item is always new, so there is nothing to match against, and the key
  isn't unique inside one item — two copies lent to one person on one day, or a book back the
  same day and lent again, are real, distinct loans the round trip must keep. Making a Nalanda
  import merge onto existing items would change how every column re-imports, not only loans.
- **More open loans than copies** can only meet inside one row, and every one is kept. The
  free-copy rule governs making a loan (`lendIfFree()`); the app doesn't keep it as an
  invariant — lowering `copies` on the edit form, or the Holding toggle to Not owned, never
  looks at loans, and the item page shows each open loan with its return button either way.
  Refusing one would drop the fact that someone has the book. Once imported, no copy is free,
  so lending refuses until one comes back.
- **Not owned (`copies = 0`)**: history and open loans both come back, for the same reason —
  a book given away while it was out is a state the app reaches and shows. The lend route
  still refuses a new loan of it.
- **A member's import restores loans too.** Loans belong to no member: there is no owner
  column, any member lends and marks returned, and nothing records who did. #43's rule that
  a member's import is all theirs attributes reads and reviews; a loan has nothing to
  attribute.
- **libib and Goodreads files have no loans**, and their mappings don't change — except that
  `loans` joins the libib mapping's known columns, beside `reads` and `reviews`: a Nalanda
  export missing a column is read as libib, and its borrowers would otherwise land in
  `details`, which share pages and connections show.

**Within the free plan.** One query a page for loans, by id range on `idx_loans_item`, as
tags, reads and reviews are read (six a page). Encoding and decoding cost about what the rest
of a row does. Timed in Node on a loaded machine, writing a page of 250 items took 0.8 ms
warm, 1.1 ms with 1,000 plain loans, 2.0 ms with 1,000 loans whose every text needed
encoding, and 5.6 ms warm and 8.4 ms cold with 5,000 of those (twenty an item); mapping 250
import rows carrying 5,000 took 11–12 ms. So an export page also ends once it holds
`EXPORT_LOANS` (1,000): the loans query reads at most 1,001 rows, the page stops before the
item they stopped in, and `x-export-next` says where to go on (it now means "more may
follow", not "the page was full"). An item with more than 1,000 loans of its own goes out
alone, with all of them, for a seventh query. The Export button needed no change. The route
without a cursor streams with no loan limit: the whole stream is one invocation, so smaller
pages would spend D1 calls and save no CPU, and it keeps its six a page of 2,000. On the way
in, `public/import.js` closes a batch at 1,000 loans as well as at 200 rows (a row with more
goes alone), and a cell keeps at most `MAX_LOANS_PER_CELL` (1,000), the latest — where the
loans still out are — so an item lent more than a thousand times comes back with its latest
thousand. `isIsoDate()` now checks a date by arithmetic instead of a `Date` round trip, which
cost about a microsecond a date; a test holds the two to the same answers. Tests count each
page's D1 calls, and the stream's: the same with 5,200 loans as with none. A shelf-scoped page
counts only its own shelf's loans, however the shelves' ids interleave.

**Privacy.** `/export.csv` sits behind `requireAuth`; a test's signed-out request is
redirected and carries none of it. Loans stay out of share pages and connection payloads
because those render items through `toPublicItem()` and `toConnectionItem()`, which have no
loan fields. Tests import loans, then check the share list and item pages and a connection's
shelf and item for every borrower, contact, note and date, while the in-app page shows them.

**Chosen without asking, overrulable:** the column's place after `copies`; id order rather
than date order in the cell; the `|key:` form for the optional parts, so a later field can
join without breaking older readers; dropping a token whose return date is unreadable rather
than guessing; the 1,000-loan bounds on pages, batches and cells; tightening the lend form's
due date to a calendar date.
