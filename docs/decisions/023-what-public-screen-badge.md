# §16 #23 — "What is public" is a screen, not a badge

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #23`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Decision #18 made shares
per-view, but the UI kept a per-shelf mental model: any share row on a shelf
rendered it SHARED, and the links themselves lived inside each shelf's
settings `<details>`. Both understate and scatter the thing that matters —
publishing is the only way data leaves this app. Now `shareVisibility()`
distinguishes a filterless link (the shelf entire → *Shared*) from captured
ones (a slice → *"2 views shared"*), and `/shares` lists every published
link across all shelves with its scope, live item count, URL, and
rotate/remove. The per-shelf panel stays as the place to *publish* (it needs
the shelf's current filters); `/shares` is the place to *review*. The count
comes from `countMatchingItems()` + `shareFilters()` — the same WHERE the
public page runs, so the number can't drift from what the link exposes.
Admin-only, like every other share mutation.
