# Runbook: Import from LibraryThing

Brings your LibraryThing catalog into Nalanda — the books with their ISBNs, publisher, pages,
media, your rating, review and comments, dates started and read, tags, collections and
language — the way the [Goodreads import](import-from-goodreads.md) does: a book already in
Nalanda gets your reading merged onto it; a book that isn't becomes a new entry — an owned copy
by default (LibraryThing is a catalog), a "Not owned" reading-log entry when it sits in **Read
but unowned** or **Wishlist**.

## Export from LibraryThing

librarything.com → **More** → **Import/Export** → **Export your library** → **Export as CSV**
(UTF-8). Large libraries take a moment; the download appears on the same page. One file
covers every collection.

## Import into Nalanda

1. Log in **as the person whose LibraryThing account it is** → **/import**. Everything the file
   brings — reads, rating, review, comments — becomes that member's own (ARCH.md §16 #43).
2. Pick the CSV and the destination shelf. The LibraryThing format is auto-detected (the
   "default type" and "music as vinyl" options don't apply). The destination only affects
   **new** entries; matched books stay on their shelf.
3. **Preview (dry run, optional)** — the first 200 rows: how many map, how many **match books
   already in Nalanda**, how many are **new**, how many **reads** it would add or date. Nothing
   is written yet.
4. **Import** — uploads in batches of 200 with live progress.

**Re-running is safe**: rows imported last time match by ISBN (or title + author) on the next
run and merge instead of duplicating.

## What maps where

| LibraryThing | Nalanda |
|---|---|
| Title | Title (a "(Series, #1)" suffix becomes the series when there is no Series column) |
| Primary Author, Secondary Author ("Last, First", several apart by `\|`) | Creators, each turned round to "First Last" |
| ISBN, ISBNs (`[0441478123, 9780441478125]`) | ISBN-13 and ISBN-10 |
| Publication ("Ace Books (2000), Paperback, 304 pages"), Date, Original Publication Year | Publisher; published year |
| Page Count | Length |
| Media (Hardcover, Paperback, Ebook, Audiobook) | Held as |
| Rating (0–5, halves) | Rating 1–10 |
| Review | Your review |
| Comment, Private Comment | Private notes (both; never on a share page) |
| Date Started, Date Read | A read's start and finish |
| Collections: Currently reading / To read / Wishlist / Read but unowned / Read | Reading status; Wishlist and Read but unowned mean not owned |
| Copies | Copies (owned entries) |
| Tags | Tags |
| Languages (the first) | Language |
| Series, Volume | Series and number |
| Book ID, Entry Date, Subjects, LCCN, Dewey, OCLC, Work id, From Where, Source… | Details (kept, lossless) |

## Matching and merge rules

The same as Goodreads': a row is matched by **ISBN-13 → ISBN-10 → normalized title +
first-author surname** (the turned-round author matches the usual order); on a match
LibraryThing wins for *your* rating, review and notes, and your reads are **added and never
removed** — importing the same file again adds nothing. See the
[Goodreads runbook](import-from-goodreads.md#matching-and-merge-rules) for the rules read by
read.
