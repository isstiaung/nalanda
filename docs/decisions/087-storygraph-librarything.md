# §16 #87 — StoryGraph and LibraryThing exports import as Goodreads' does: matched and merged, the importer's own reads and reviews

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #87`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Goodreads is not the only place people keep their reading. **The owner decided** on two more
mappers beside Goodreads' — StoryGraph and LibraryThing — match-and-merge, the importing
member's own reads and reviews, a runbook and a fixture each.

**What was decided:**
- **Recognised by their columns**, after our own export and Goodreads' (`looksLikeStoryGraph()`:
  Read Status and Dates Read; `looksLikeLibraryThing()`: Primary Author beside Entry Date or
  Book ID), before libib, which is the fallback. Column names are read as these files write them
  — "ISBN/UID", "Owned?", "Character- or Plot-Driven?" — through one normalisation
  (`columnKey()`), so a renamed or reordered column still lands.
- **The same path as Goodreads.** Each mapper yields a `MappedRow` with a `goodreads` reading
  (shelf, last finish, last start, count), so `mergeImportItems()` matches a row by ISBN-13,
  ISBN-10, then title and first-author surname (#14), reconciles the reads already here by the
  rules of #41 (`reconcileGoodreads()`, added and never removed), lets the file win for the
  importer's own rating and review (#43), and inserts the rest; a re-import adds nothing. The
  Import page's preview and messages name the source.
- **StoryGraph** (`mapStoryGraphRow()`): every dated range in "Dates Read" is a read of its own
  — the file's one gift over Goodreads', which has only the last — with an open range while
  currently reading as the open read; Read Status to the four statuses; Star Rating in halves
  and quarters to 1–10 (4.25 → 9); Format to the copy's form (#75); **Owned? decides copies**
  (Yes: one; No: a reading-log entry); Tags to tags; moods, pace, warnings and the rest stay in
  details, lossless, as Goodreads' extra columns do. A "(Series, #1)" title suffix becomes the
  series (#52). StoryGraph has no publisher, pages or notes.
- **LibraryThing** (`mapLibraryThingRow()`): the "Last, First" author turned round (several
  apart by `|`); ISBNs out of their brackets; publisher and year out of "Publication"; Page Count,
  Media, Rating in halves, Review; Comment and Private Comment both as private notes; Date Started
  and Date Read as a read's two ends; **the collections say the status and the holding** —
  Currently reading, To read, Wishlist, Read but unowned, Read — with a bare catalogue entry an
  owned copy (LibraryThing is a catalog) and Wishlist or Read but unowned not; Copies; Tags;
  Languages to the item's language (#76, by name); Series and Volume to the series.
- **A runbook each** (`runbooks/import-from-storygraph.md`, `…-librarything.md`): how to export,
  what maps where, and the merge rules by reference to Goodreads'.

**What it rules out:** a fourth mapper for every reading site (the three cover the ones people
leave); importing StoryGraph's moods and pace as anything but details; a LibraryThing "Reading
Dates" history beyond Date Started and Date Read (the export's newer column, not in the sample
the format was taken from — a later version can add it); lending records from LibraryThing's
Lending columns (a loan here is the household's, #57).

`test/storygraph-librarything.spec.ts` holds it: the four exports told apart; a StoryGraph row's
every field, its dated reads, its statuses (an open read while currently reading, did-not-finish,
to-read), an unowned ebook, a UID kept as written; a LibraryThing row's author turned round,
ISBNs, publisher and year, pages, media, both comments, collections, language, series; through
the Import page both recognised, merged onto the book here by ISBN with the importer's read and
review, the rest added as the file says, and a second import adding nothing.
