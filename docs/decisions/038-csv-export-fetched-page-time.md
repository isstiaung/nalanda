# §16 #38 — CSV export is fetched a page at a time, and the browser joins the pages

**Decided:** 2026-09-28 (measured, not assumed). Cited as `ARCH.md §16 #38`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The export
streamed the whole catalog from one request, and a stream's work all counts against that one
invocation's 10 ms of CPU. The pre-deploy review estimated 15–20 ms for production's 1,998
items; timing the real `pageItems` and `itemToCsvLine` in V8, on rows heavier than production's,
gave 12 ms warm and 20 ms on a cold isolate for 2,000 items, 1.8 and 6 ms for 250. So the
Export button asks for `/export.csv?after=<id>`: one page of 250 items a request, the header row
on the first page only, and `x-export-next` naming where the next starts until a page comes
back short. `public/import.js` joins the pages into one Blob and saves it under the filename
the first page names. A page that fails fails the export, and nothing is saved, and a lapsed
session can't slip the login page into the file (`redirect: 'error'`, and each page must be
`text/csv`). Imports already worked this way round, in 200-row batches. The route without a
cursor still streams everything in one response: what the link does without JavaScript, and
what a script fetching the URL gets. On a large catalog the runtime can cut that off, and the
download then fails rather than stopping short. Workers Paid's 30 s would have made the stream
enough on its own, but this app stays on the free plan.
