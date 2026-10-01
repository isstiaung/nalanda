# §16 #27 — Holding is its own column, and its toggle spans only 0 ↔ 1

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #27`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

"Not owned" used to
ride along beside the status pill; it is now a Holding column in the shelf table and a
Holding row on the item page, so ownership reads separately from progress. The pill is
a one-click htmx toggle (`POST /items/:id/mark-owned` and `/mark-not-owned`, each
swapping itself for the other direction) — the common move is a logged book arriving
on the shelf, and that shouldn't need the edit form. **The toggle deliberately refuses
items held in 2+ copies**: it can only land on 0 or 1, so offering it there would
silently discard a recorded count, and `copies` round-trips through `/export.csv`
(§12). Those render a plain `N copies` pill, and the route returns that untouched
rather than zeroing — the guard is server-side, not just a hidden button. Grid cards
keep the non-interactive pill: they sit inside the card's own link, and nesting a
button there is invalid HTML. Share pages are untouched — they use the plain
`NotOwnedPill`, never `ItemTable`, so no mutation control or authenticated-app link
can reach a public page (§9).
