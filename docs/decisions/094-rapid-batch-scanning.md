# §16 #94 — Rapid batch scanning: "Keep scanning" holds each barcode on the device; "Add all" resolves them twenty a request, as bare records, covers later

**Decided:** 2026-10-01 (a shelf scanned in one go). Cited as `ARCH.md §16 #94`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here. Numbered after #92; #93 is taken on another branch.

Cataloguing a shelf meant, for each book: scan, wait for the lookup, pick a shelf, press Add, scan
the next — a round trip and three taps per barcode, with the camera stopped in between. The
offline queue (#48) already held barcodes on the device for a review list to add later. **The
owner decided** to make that the fast path, online too: a "Keep scanning" toggle on the Add page
under which each barcode goes straight into the review list (a count, a beep, the camera stays
open), and "Add all" posts the list in batches, each code resolved by the usual lookup, with a
report of what was added, what the catalog already had, and what nothing was found for. **Online
and offline scanning are one mode.** New items are **bare records** — covers and descriptions come
later from the existing cover backfill, which paces itself — not from two hundred provider
requests in a row.

**What was decided:**
- **One queue, one list.** With the box on, `scanner.js` holds a barcode exactly as it holds one
  offline — `scan-queue.js`, the same `{ barcode, scannedAt }` row, the same owner stamp, a repeat
  held once (the queue's `already`) — and the camera keeps going. The box is remembered per device
  (`localStorage`, `nalanda:keep-scanning`), off until someone turns it on; the offline page has no
  box and always holds. The Add page's review list shows what the device holds, whichever way it
  came: the barcode and when it was scanned, with **Look up** and **Drop**. Nothing is looked up at
  scan time, and nothing is looked up on page load either — the list of 200 barcodes costs no
  request until someone acts on it.
- **"Add all to <shelf>"** posts the list to `POST /api/scans/add` (`{ libraryId, codes: [{ code,
  at }], scanOwner }`), **at most 20 codes a request**, the browser looping as the CSV import does
  (`nalandaScanBatch` in `scan-review.js`, DOM-free so a test can run it). Each request: refuses
  another account's scans by `scanOwner` as `POST /items` does (409); runs `lookupByBarcode()` for
  each code, four at a time (Open Library refuses bursts) — ISBNs to Open Library and Google Books
  together, anything else to Discogs when a token is set; checks the catalog with **one**
  `catalogMatches()` query for the whole batch — a found code by what its candidate names (ISBN-13,
  a record's barcode or Discogs id), an unknown one by the barcode itself, so a shelf catalogued by
  hand reads as "already here" and never as "not found"; a book scanned twice in one run (its ISBN-10
  and its EAN-13) is added once; and inserts the rest in **one D1 batch** (`addScannedItems()`,
  through `asWriter()` for the history marker and the sweeps, #84). It answers `{ added, already,
  notFound, notices }` — `added` and `already` each with the item's id and title, `notFound` the
  barcodes, `notices` the lookup's reasons for those. The browser settles each entry as its answer
  lands: added and already-here entries leave the device's queue and become a line with the title;
  an unknown barcode **stays on the list** with **Add by hand**, which opens the manual form with
  the barcode filled in (`GET /add?barcode=…`). The status line (`aria-live`) reports "N added, M
  already here, P maybe already here, K not found" and points at the cover backfill.
- **Maybe already here — held, never added.** A fifth of a catalogue's books carry no number at
  all (Goodreads reading-log entries, mostly) and would be added again by their barcode. A found
  book that no number matched is met against the catalog's ISBN-less books by title and author —
  `isbnlessBookIndex()`, the `TitleIndex` the Goodreads-style imports and the Kindle import match
  with (stem and surname, then the whole first-author name, so Brian Herbert's *Dune: House
  Atreides* never meets Frank Herbert's *Dune*) — one more query, loaded only when such a book is in
  the batch. A hit is **held, not added**: the report counts it as the third number, the entry
  names the catalog's copy, linked, "(Not owned)" when it is — its page's Holding toggle is then the
  likely next step — and keeps **Look up** to decide; the review entry gains no new control for it.
  Beside that, a book catalogued with only its **ISBN-10** is found when its EAN-13 is scanned:
  `catalogMatches()` carries the ISBN-10 a 978 EAN stands for (`isbn10OfEan()`, the inverse of
  `isbn13Of()`) as one more key in its one query, hyphens and case aside; a 979 EAN has none.
- **Why 20.** A Worker invocation may make 50 outbound requests. Twenty codes × two book providers
  is 40, a record's single Discogs request fewer, and nothing else in the request goes outside — so
  a batch stays under the cap with room to spare, whatever mix of books and records it holds.
  D1: the session, the shelf with the household's settings, the catalog check (two calls when
  something matched), the ISBN-less index (only when a found book matched no number), the matched
  titles (only when something matched), the insert — four to six calls for twenty items, pinned in
  the tests.
- **Bare records, by design.** What the lookup's JSON carries and nothing fetched for it: title,
  creators, publisher, published, ISBNs, length, a description when Google Books' answer had one,
  the series Open Library names, the household's language unless the provider said (#76), a
  record's carrier from the pressing's format (#75). **No cover** — not Open Library's, not the
  Cover Art Archive's — **no work-record description, no Discogs release** for the tracklist
  ("Refresh from Discogs" fills it later from the id kept in `details`). The cover backfill
  (`/api/backfill-covers`, the Import page) finds the covers afterwards at its own pace. An Add
  from the page is unchanged: one item, its cover fetched on save.
- **Whose, and what it tells.** Items are the signed-in member's (`added_by`), today's news to
  connections as an Add is — the batch does not carry the import marker, since nothing in it is
  dated by a file. The queue still holds a barcode and a time only; the request adds `libraryId`
  and the device's stamp, nothing about anyone.
- **Signals.** The beep is Web Audio (an oscillator, no file), made on Start — a click — so browsers
  let it sound; beside it the vibration and the status line's running count, so sound is never the
  only signal (§18). The box is a labelled checkbox; the report is `aria-live`.

**What it rules out:** per-scan provider calls at scan time (a lookup for each barcode as it is
found — the camera would wait, and a shelf is two hundred requests); covers at scan time or in the
batch (a cover per item on top of the lookups would pass the subrequest cap at thirteen codes, and
the backfill already paces itself against the providers); a second queue or a second list for
online scans (one shape, one owner stamp, one "Add all"); looking the whole list up on page load
(what #48 did, two at a time — now only on **Look up** or **Add all**, so an open list costs
nothing); more than twenty a request, or a server-side loop over the list (one request's budget);
adding anything unseen beyond what the report names — every item added is listed by title, and is
an item the trash takes back; adding on a title match (a maybe is only ever named — the imports
merge on one, a run of scans doesn't).

Tests: `test/scan-batch.spec.ts` (the endpoint: owner mismatch, the caps, bare records in one
batch with their writer, already-here by ISBN-13, by ISBN-10, by a record's barcode and for an
ISBN-10-only book by its EAN-13, a twin in one run, a maybe held with nothing inserted and the
index asked once — the same title by another author added — the call counts pinned, not-found
reported and nothing inserted, nothing fetched but the providers, a full twenty in five D1 calls,
the page's box, status line and prefill) and `test/scan-batch-browser.spec.ts` (the
browser loop against the Worker: twenty a request, a repeat once, stopping at a refused batch, a
lapsed session read as signed out). Amends #48: its review list no longer looks each entry up on
load.
