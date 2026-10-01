# §16 #77 — Quotes are a member's own, private until each is marked shared; Kindle highlights come in as quotes, parsed in the browser

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #77`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Quotes and highlights are Goodreads' second most used feature after shelves, and Nalanda
had only one private note per item. People copy down two kinds of line: one they would
happily share, and one that is a reminder to themselves. **The owner decided** on a per-quote
switch rather than one treatment for both, and asked for a Kindle import.

**What was decided:**
- **A `quotes` table** (migration 0043): item, member (`user_id`, NULL once they are removed —
  the quote stays, a former member's, as a review does), the text, an optional page or Kindle
  location, an optional note (the reader's own words beside the author's), `shared`, `source`
  ('kindle' for an import), and `at`. Added from a book's page under "Quotes and highlights",
  listed there under each writer, editable and deletable by the writer or an admin — in the
  route and in the statement, as reviews are (#43) — and on a per-member **Quotes** page
  (Reading in the sidebar), newest first, with the household picking whose.
- **Private by default; shared one quote at a time.** A quote reaches `toPublicItem()` only
  when its `shared` is on (`sharedQuotes()`, passed as `opts.quotes`), and only as its text and
  page: never the note, never a username. It is signed with the writer's display name only
  while `names_on_shares` is on (#45), else "A member". A page with no shared quotes serializes
  byte for byte as before (the key is absent), as every optional key does. **Not to
  connections yet**: the feed and the connection item page carry reviews under their own
  machinery, and quotes will follow with the same rule as a change of their own, so this
  change touches no federation message.
- **The Kindle import** takes `My Clippings.txt` and the Kindle app's notebook HTML, **parsed
  in the browser** (`public/kindle.js`, an ES module so `test/quotes.spec.ts` runs the same
  code; §12: no bulk parsing on the server) and posted as books with highlights, at most 25
  books and 2,000 highlights a request (`/api/import/kindle`). Each highlight becomes the
  importer's quote, dated when Kindle recorded it; a note Kindle wrote at the same place
  becomes the quote's note, a note on its own is kept as the reader's words; bookmarks are
  ignored. Books match by title and first author, the Goodreads matcher's rule (`titleKey`); a
  book not here is made as a Not owned reading-log entry on the shelf chosen — a book you
  highlighted is one you read (#14's reasoning) — and the preview says which are new.
  **Importing twice adds nothing twice**: `quoteInsertStatements()` skips a quote the same
  person already has of the same text on the item. One call reads the catalog's books, then
  one batch per book.
- **The CSV** gains a `quotes` cell, JSON like the `reviews` cell, with each writer's username;
  an import resolves names as reviews' writers are resolved (`attributePeople`): a member's
  import makes every quote theirs, an admin's keeps names that are members here. The trash
  snapshot carries quotes and a restore hands each back only to the id that still has its
  key (#74).

**What it rules out:** a quote on share pages by a household switch alone (the per-quote
choice is the point); a quote's note anywhere outside the app; parsing the Kindle file on the
server; a Kindle import that creates nothing for an unknown book (the owner chose creation).

`test/quotes.spec.ts` holds it: the library's tidying and cells; the browser parser on a
clippings file (highlight-and-note pairing, a lone note, a bookmark, "Last, First", dates) and
on the notebook HTML; add, refuse, edit, share, delete and the member and admin guards on a
book's page; the Quotes page and whose; the share page with names off and on, never a note or
a private quote, and `toPublicItem()` byte-identical without quotes; the Kindle API's dry run,
matching, creation, dating, re-import, limits and junk; the CSV cell both ways; the trash;
a removed member's quote as nobody's.
