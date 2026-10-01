# §16 #83 — Author A–Z sorts a shelf by the first creator's surname, in SQL, by the same rule as the creators pages

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #83`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A shelf could be sorted by title, rating, date completed or newest first, never by author — the
order every bookshelf in the house keeps. **The owner decided** to add it, by surname.

**What was decided:**
- **"Author A–Z"** on the shelf's sort select (`sort=author`), and on a share link's publish
  form like the other sorts: `shares.sort` and `connection_views.sort` take `author` (a widened
  TypeScript enum; SQLite stores plain text, so no migration).
- **The surname is worked out in SQL**, in the ORDER BY, from the `creators` string as stored —
  no column to maintain on every write path, no backfill, and the page can't disagree with the
  creators pages (#72): `AUTHOR_SORT_SQL` in `src/db/queries.ts` applies `splitCreators()`'s
  "Last, First" rule — one person written "Le Guin, Ursula K." sorts under *le guin* — and
  otherwise takes the first person (before a `,`, `;` or ` & `) and sorts under their last word,
  as `surname()` does for matching: "Ursula K. Le Guin" under *guin*, "N. K. Jemisin" under
  *jemisin*, "Terry Pratchett, Neil Gaiman" under *pratchett*. SQLite has no "last word": the
  trailing word is what remains when `rtrim()` strips every non-space character from the right.
  A trailing suffix without a comma — "Martin Luther King Jr.", "Ralph Bunche II" — gives way to
  the word before it, so they file under *king* and *bunche* (review on #122).
- **Then the full creators string, then the title**, all lower-cased; items with nobody named
  come last, not first under an empty key.
- **Measured nothing new:** the sort is an expression over the rows a page already reads; the D1
  calls per shelf page are unchanged, and the budget tests say so.

**Known limits:** `lower()` folds ASCII only and D1 has no ICU collation, so a surname starting
with Å, Ø, Č or Ł keeps its capital and sorts after every ASCII name; a JS-side sort would break
the page's LIMIT/OFFSET, so this stays. An expression sort can't use #68's indexes: a shelf sorted
by author is read through a temp B-tree, about twice its item count, as sort by rating is — fine
for an opt-in sort.

**What it rules out:** a stored sort key or a creators table (the creators pages chose strings
over a table, #72, and this follows); a "Surname, Given" display — the sort changes order, never
how a name is shown; sorting by a creator other than the first.

`test/author-sort.spec.ts` holds it: the order over the rule's cases — a "Last, First" person,
initials, two people by comma and by ampersand, two authors sharing a surname, no creators last —
on the shelf and through a share link published with that sort; the select's option; and the
shelf page's D1 calls unchanged.
