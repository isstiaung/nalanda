# §16 #80 — Search operators: seven prefixes on the search box, applied inside the one id query; anything else is text

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #80`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The search box took plain words only: "le guin" found everything mentioning her, and narrowing
to the unread ones meant leaving search for a shelf's filters. **The owner decided** on search
operators — `author:`, `tag:`, `status:`, `year:`, `lang:` — with FTS5 column filters where the
column is indexed and plain filters where it isn't, and an unknown prefix left as text.

**What was decided:**
- **Seven operators**, parsed once in `src/lib/search.ts` (`parseSearch()`): `author:` (also
  `creator:`, `by:`) and `title:` are FTS5 column filters on `creators` and `title`;
  `tag:`, `status:`, `year:`, `lang:` and `type:` are WHERE clauses on `items`. A double-quoted
  value is one phrase (`author:"le guin"`); every word and phrase is matched as a prefix, as plain
  words always were. Several operators are all required; the same operator twice is either
  (`year:1930-1939 year:2019`), except `tag:`, which an item must carry every one of.
- **Values read as people say them.** `status:` takes the pills' names and their synonyms —
  unread, reading, read, abandoned, and the likes of tbr, re-reading, finished, dnf — never only
  the column's values. `year:` is a year or a range either way round. `lang:` is an ISO 639-1
  code or an English name (`languageCode()`). `type:` is book, game, record and their plurals and
  synonyms. **A value an operator can't read, like an unknown prefix, is searched as the text it
  is** (`status:maybe`, `re:zero`, `12:30`), so nothing typed is silently dropped.
- **One id query, two calls, as before.** `searchItems()` builds the FTS5 MATCH expression
  (`ftsMatch()`) and puts the filters inside the same statement as `rowid IN (SELECT id FROM items
  WHERE …)`, so a narrowed search still finds up to the limit and the page's D1 calls don't change.
  A query of operators alone (`tag:fantasy status:unread`) skips FTS and lists by title.
- **The twins hold.** `status:` is `statusWhere()`'s SQL again: In progress holds a re-read
  (#64). `lang:` reads an item with no language of its own as the household's, as its pill does
  (#76): `coalesce(language, site_settings.language, 'en')`. `year:` reads the four digits
  `published` starts or ends with ("2019-05-01", "May 2019"); the page's `yearOf()` takes the first
  four digits anywhere — SQLite has no regex, and those two shapes are what providers and files
  write. "Read by" still narrows inside the query (#43).
- **In the app only.** Operators are the search page's; a share link captures `ItemFilters`, never
  the search box (`q` matches `location`, [privacy.md](../privacy.md)), and nothing here changes
  that.

**What it rules out:** negation (`-tag:x`) and OR between different operators — not asked for,
and the help line would stop fitting on one breath; a saved search — that is #7 of the queue,
saved filters.

`test/search-operators.spec.ts` holds it: each operator parsed, the synonyms, ranges either way
round, unknown prefixes and unreadable values kept as text, the FTS5 expression's shape; and
against D1 — tag, type and author narrowing a text search, author: looking only at creators, the
year at either end of `published`, lang: by code and name with the household default, status:
with a re-read in both, operators alone listing by title under the limit, "Read by" combined; and
the page's help line and results.
