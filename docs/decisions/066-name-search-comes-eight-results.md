# §16 #66 — A name search comes eight results a page, best match first, and each result starts on the shelf that holds most of its type

**Decided:** 2026-09-30 (Add-page search: ranking, pages, and a starting shelf). Cited as `ARCH.md §16 #66`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

BoardGameGeek's `search` answers every match at once in no useful order, and keeping its
first eight (the old `firstIds()`) lost the game asked for whenever more than eight titles held the word — the
owner searched "Cryptid" and got "48 Rooms: Cryptid Maze" but not Cryptid. `rankedIds()` in
`src/metadata/bgg.ts` ranks the whole answer by a string scan (no parse, inside the CPU budget): the name folded
(case, accents, punctuation) equal to the query, then starting with it, then holding it as a word, then anywhere;
a primary name before an alternate; ties in BGG's order; a game listed under several names once. `thing` answers
in id order, so the page is put back in the ranking's. Open Library and Discogs rank by relevance and page
themselves (`page=`); BGG has no paging, so a later page asks the search again (two requests a page, as the first
always was). **More results** is a button under the page (`hx-get` with `page`, `hx-target` its own wrapper,
`outerHTML`); the next page comes back wrapped under the same id, so app.js's afterSettle handler lands focus on
it. Fifty pages at most; a barcode lookup never pages; a later page that comes back empty says "No more
results." The BGG and Discogs credits stay once, on the first page. **The starting shelf:** shelves have no
type, so the picker used to start on the first shelf for every result. `shelfForType()` — one query, the shelf
holding most items of each type, ties to the shelf listed first — sets it for search results and held scans;
a type the catalog doesn't hold yet starts on the first shelf, as before. The results page costs one more D1
call than before (three, whatever the results). `scripts/a11y.mjs` presses More results from the keyboard after
a book search for a common word — Open Library is keyless, so it needs only the internet, as the audit's other
Add-page lookup does, and when Open Library can't be reached the state is reported as not audited — then runs
axe on the next page and checks focus landed on its wrapper. (It was left out at first, as needing a provider.)
