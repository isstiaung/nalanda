# §16 #28 — Table columns are a per-device choice, kept in localStorage

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #28`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The shelf table
reached ten columns, and one fixed set cannot serve three media types — a vinyl shelf
has no use for "Completed", a board-game shelf would rather see play time than Year.
A "Columns" dropdown (the existing `FilterMenu` pattern, so it looks native) toggles
everything except Title, which stays so a row remains identifiable. **The server always
renders every column**; hiding is presentational only, via `col-*` classes and a
`data-hide-cols` attribute on `<html>` — so with JS off you get the full table rather
than a broken one, and htmx swaps can't lose the setting. The attribute is applied by
a small inline script in `<head>` rather than deferred `app.js`, or the full table
would paint before columns visibly vanished. Storage is deliberately **not** the
server: this is display preference rather than catalog data, it wants to differ
between a phone and a laptop, and putting it in D1 would mean a migration and a write
on every toggle for something that matters to one browser. The checkboxes carry no
`name`, so they never join the surrounding GET filter form.
