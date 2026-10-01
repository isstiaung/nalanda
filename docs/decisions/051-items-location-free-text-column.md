# §16 #51 — An item's location is one free-text column, private like notes, and searchable

**Decided:** 2026-09-30 (where it lives). Cited as `ARCH.md §16 #51`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A household
with books in three rooms and games in the loft wants to know where a thing is. The owner
decided each point:
- **Free text, optional, one per item** — `items.location`, "study, 2nd shelf" or "Loft · box 3",
  in the household's own words. Not a table of places, not per copy: two copies in two rooms
  are one line of text ("one in the study, one in the loft"). Set on the item form, adding (the
  manual form) and editing; shown as a Location row on the item's page when there is one. The
  form keeps it one line with spaces collapsed; blank is none.
- **Search finds it.** It joins the FTS index as a fifth column, so global search matches it;
  a shelf's search box matches it beside title and creators (a `LIKE`, as those are). FTS5
  can't add a column, so migration 0032 — a custom one, after 0031 adds the column — drops
  `items_fts` and its three triggers, makes them again with `location` added and bodies
  otherwise unchanged, and refills the index with `'rebuild'`. The index is external-content
  (`content='items'`), so dropping it loses nothing. Rehearsed on the backup of 2026-09-29
  (1,998 items): every table's existing columns identical row for row, and 242 searches
  returning the same items in the same order.
- **Never published.** It is not in `toPublicItem()` or `toConnectionItem()`, so share pages,
  a connection's shelf, item page and feed never carry it; tests serve each with and without
  a location and compare byte for byte, names switched off and on. The item activity triggers
  fire on `review`, `rating`, `status` and `completed_on` only, so changing a location is no
  news. A shelf's search box matches it, but share links and connection views never capture
  that box's text (`shareFilters()`, `shelfPage()`), so no published view can be filtered by
  where things are kept.
- **Portable.** `/export.csv` has a `location` column after `notes`, and a Nalanda export maps
  it back. A libib-style file with a `location` column fills it too: an unrecognized column
  would otherwise land in `details`, which share pages and connections show.

**Chosen without asking, overrulable:** the scan and search result cards' one-click "Add to
shelf" doesn't ask for a location — it stays one click, and the edit form is a click away;
a location isn't a shelf-table column; its search in a shelf's box is a substring match, like
title and creators there; a pasted line break becomes a space.
