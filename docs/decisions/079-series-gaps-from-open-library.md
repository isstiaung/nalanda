# §16 #79 — A series' missing volumes can be found on Open Library, on a click; the household's series data always wins

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #79`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A series page already knows which numbers are missing (#52). Open Library's search index
knows series membership for many works. **The owner decided** to join the two — "as long as I
can overwrite the series data" — so Open Library only ever suggests.

**What was decided:**
- **"Find the missing volumes on Open Library"**, a button on a series' page: one keyless
  search for the series' name (`olSeriesWorks()`), kept to the docs whose series matches it
  by `seriesKey` (case and spacing aside), each with the position Open Library gives it. On a
  click, never in the background, as a GET (no side effect: reload and Back work); answers
  cached per isolate for a day, as #78's are, and **no answer is never cached** — the page says
  "Open Library didn't answer" and the next click asks again.
- **Sorted against the household's own numbering.** A work whose number is one the series is
  missing (`missingNumbers`, `inRanges`) is offered to add, log or want as an Add-page card;
  a work whose number the household already holds, or which is in the catalog by ISBN
  (`catalogMatches`) or by title, counts as here and isn't offered; a work without a number
  Open Library knows, or one past the household's total, is listed apart.
- **The household's data always wins.** Every offer carries the household's series name and
  Open Library's number — never Open Library's name, never a renumbering — and what you have
  numbered yourself is never changed: adding an offered volume is an ordinary add with the
  series fields prefilled, editable on the form like any other. A series' total is never set
  from Open Library either.
- **Measured (2026-10-01):** Discworld's forty works with ISBNs come back as 74 KB and parse
  in 0.17 ms; without ISBNs 29 KB — nowhere near the 10 ms budget, so the ISBN field stays
  for the "already here" match. Forty is the limit asked for; a longer series, or one whose
  search also returns omnibuses, may come back incomplete, and the page says how many Open
  Library listed. `series_name` and `series_position` are parallel lists: when their lengths
  differ a position may belong to another of the work's series, so the work is listed without
  one rather than offered under a wrong number (`seriesOf()` now guards the same way).
- **Only some works carry series records** (checked 2026-09-30: The Expanse and Discworld do,
  Earthsea doesn't), so an empty answer says nothing about the series, and the page says so.
  A rehearsal against the owner's real catalog is the next step before leaning on it.

**What it rules out:** writing a series name, number or total from Open Library; a background
sweep of every series; offering a number the household already holds under another title.

`test/series-gaps.spec.ts` holds it: the look-up making one stubbed request, docs of other
series dropped, a gap offered with the household's name and Open Library's number, a held
number and an ISBN match counted as here, an unnumbered work listed apart, the household's
numbering untouched, the cache, an empty answer, and a series that isn't there.
