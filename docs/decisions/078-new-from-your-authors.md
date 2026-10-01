# §16 #78 — Discovery is one page: the works of authors you have finished, from Open Library, on a click — and nothing more

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #78`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Goodreads' hold on people is discovery — new books from authors they've read, what readers
like them enjoyed — and Nalanda had none, by design but not by decision. **The owner decided**
how far to go: this page, and a series' gaps (#79), and no "readers like you".

**What was decided:**
- **"New from your authors"** (`/discover`, Reading in the sidebar) lists the authors of the
  books the signed-in member has finished, most finished first (`finishedAuthors()`: their
  completed reads' creators, split by the Creators rule, #72), each linked to their Creators
  page with a **Look up** button.
- **Looking one up is one request, on a click.** `olRecentByAuthor()` asks Open Library's search
  index by author name, newest first, keyless, twelve works; nothing runs in the background, and
  the page itself makes no provider call. The look-up is a GET (`/discover?author=`): it has no
  side effect, so the result can be reloaded, bookmarked and come back to. **Only an author the
  member has finished** can be looked up — the list the page shows — so the route is never a
  general proxy to Open Library. Answers are kept per isolate for a day (`worksOf()`), two
  hundred authors at most, so a household looking twice asks once; **no answer is never cached**
  (a burst block or an outage returns null, the page says so, and the next click asks again),
  while a genuine empty answer is. **Measured (2026-10-01):** Terry Pratchett's twelve newest
  works with ISBNs come back as about 3 KB and parse in well under a millisecond; a series'
  forty works (#79, Discworld) as 74 KB, parsed in 0.17 ms — nowhere near the 10 ms budget, so
  the ISBN field stays in the request.
- **What is already here is marked.** Each work is matched as the Add page matches (#93's
  `catalogMatches()`, by ISBN) and, for a work without one, by title and author
  (`booksNamed()` + `titleKey`), and shows "In your catalog"; the rest are ordinary Add-page
  cards — Add to shelf, Log — not owned, Want — so a found work lands as any search result does.
- **In the app only.** Nothing here reaches a share page or a connection, and nothing about a
  member's reading leaves the instance: the request to Open Library carries an author's name,
  which is public catalogue data, and nothing else.
- **The README says this is the extent of discovery**: these two pages, and no recommendation
  engine, no "readers like you", no sending reading history anywhere.

**What it rules out:** background polling of providers; any third party seeing a member's
reading; a recommendation model; "readers like you" across connections (deferred by the
owner, not refused).

`test/discover.spec.ts` holds it: the authors from a member's own finished reads, most first,
and nobody else's; a lookup making one request and answering from the cache after; works
marked by ISBN and by title; an empty answer; the page with no finished books; the sidebar.
