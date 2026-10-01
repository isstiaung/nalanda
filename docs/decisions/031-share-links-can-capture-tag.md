# §16 #31 — Share links can capture a tag

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #31`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Shelf filters can't express a hand-picked list —
"the books I've reviewed on my blog", or a Goodreads shelf like "to-read-2020" that
arrived as a tag — and a book lives on exactly one shelf, so a shelf can't serve as that
list without pulling books out of the shelf they belong to. `shares.tag` (migration
0011) publishes everything carrying the tag. Such links are published, rotated and
removed on the tag's own page and span every shelf (`library_id` null), owned or not.
Scope is enforced in both places, as before: `shareFilters()` adds an `EXISTS` over
`item_tags`, and `itemMatchesShare()` now takes the item's tags, so the public item
route loads them before deciding. A tag link never counts as exposing a shelf entire.
