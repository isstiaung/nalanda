# §16 #81 — Saved views are the household's: a shelf's filter bar under a name, two decluttering presets, in the app only

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #81`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Share links already capture a filter set (#18); the same mechanism pointed inward is what libib's
collections and Goodreads' custom shelves really are. **The owner decided** saved filters are the
household's, not per member, with the two decluttering views shipped as presets, and that the
"Read by" filter may be saved — inside the app.

**What was decided:**
- **A saved view is the filter bar, verbatim.** `saved_views` (migration 0046) holds a name, the
  shelf, who saved it, and `params`: the bar's query string exactly as the bar writes it
  (`shelfQueryString()`), read back by the same code that reads the shelf's own URL
  (`parseShelfQuery()` in `src/routes/libraries.tsx`). One parser means a view can hold only what
  the bar can — types, statuses, holding, formats, the search box, "Read by", the sort, and the two
  decluttering filters — and an unknown key or a bad value is dropped on the way in, on the way out,
  and again when the view is opened. The page and the display (table or covers) are the URL's own,
  never the view's.
- **The household's, any member's.** Any member saves one from the bar ("Save view"), replaces one
  by saving under the same name, or deletes one (`saveView()`, `deleteSavedView()`); the Actor
  guards of reads and reviews don't apply — a view is a shelf's, like its name. At most 20 a
  shelf, checked in the insert. A saved "Read by me" is each member's own when they open it
  (`parseReadBy()` resolves `me` for whoever is looking); a member removed since is no filter.
- **Where they show, at no extra call.** Every shelf's views come back in `shelvesWithTotals()`'s
  batch (#68), which the shelf page and the Overview already read, so neither page's D1 count moves
  (the budget tests still pin 7). Under the shelf's filter bar, a row of pills — the presets, then the
  shelf's saved views by name — with the open one marked (`aria-current`) and "Delete view" beside
  it; on the Overview, under each shelf's name. Opening one is `?saved=<id>`, and the bar's
  checkboxes show its filters, so a view is a starting point: change anything and Apply, and the
  URL is an ordinary filtered shelf again, ready to be saved under another name.
- **Two presets on every shelf**, links rather than rows, so they can't be deleted and need no
  migration: **Unread for years** (`owned=1&status=not_started&addedYears=3`) and, on a shelf
  holding games or records, **Not played lately** (`owned=1&unplayedMonths=12`).
- **Two decluttering filters behind them**, `addedYears` and `unplayedMonths` (1–99), in the app
  only like "Read by" (#43): `StaleFilter` in `src/db/queries.ts` is handed to `listItems()`
  beside `ReaderFilter`, deliberately outside `ItemFilters`, so `shareFilters()` and a
  connection view have no room for them — "not played in a year" says something about the
  household's evenings, and a share page never shows a play's date (#54). `addedYears` compares
  `added_at`'s day with the device's day (#69) less that many years; `unplayedMonths` keeps games
  and records (`PLAYABLE_TYPES`) with no play since the device's day less that many months, never
  played included — never a book.
- **Not in the export, in the backup.** Views are about the household, not about items, like
  reading goals (#49): `/export.csv` doesn't carry them, `npm run backup` does (`saved_views` in
  the table order, after `libraries` and `users`). The sharing form on a shelf with a view open
  carries only what it always did — a type, a status, holding, the sort — never `q`, `readBy`,
  `addedYears`, `unplayedMonths` or the view's id.

**What it rules out:** per-member views (the owner chose the household's); a saved search of the
Search page (search operators, #80, are typed each time); publishing a view (it would need a share
to point at it, and a view can hold what no share may).

`test/saved-views.spec.ts` holds it: the parser reading only the bar's keys and writing them back
the same way; "added years ago" at its edge day; "not played in months" with never, lately and long
ago, and never a book; any member saving, replacing by name and deleting; the cap of twenty and a
replacement still going through; the bar's save keeping neither the page nor the display nor an
unknown key; `?saved=` applying for another member with the URL's own display; the Overview's list;
the presets, "Not played lately" only beside games or records, and the open one marked; and the
publish form carrying none of a view's keys.
