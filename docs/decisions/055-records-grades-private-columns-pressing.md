# §16 #55 — A record's grades are private columns; its pressing is public `details`, filled from Discogs on add and by a refresh that only fills blanks

**Decided:** 2026-09-30 (a record's condition and pressing). Cited as `ARCH.md §16 #55`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner decided three things:
grade each record's media and sleeve by hand, in-app only; take its pressing from Discogs;
and let a button fill that pressing for records already in the catalog without overwriting
anything edited by hand.
- **Grades: two columns, `media_condition` and `sleeve_condition` (migration 0034).** Not
  `details`, for privacy first: share pages render `details` whole and connections get
  its plain values, so a grade there would publish itself. A column is in no whitelist
  until someone adds it (§9), and it filters and exports as its own CSV column. Stored
  as Discogs' marketplace codes — M, NM, VG+, VG, G+, G, F, P, and for a sleeve only
  Generic and No Cover (Discogs' own list, which also has "Not Graded": here that is NULL).
  The form and the imports check the same fixed scale (`parseGrade()`), and an import
  also reads Discogs' wording ("Near Mint (NM or M-)", and "M-"). A grade off the scale
  is refused by the form and dropped by an import — never kept in `details`, where a
  libib import puts columns it doesn't know. Only a record (`vinyl`, `music`) takes a
  grade; a record whose type changes loses them.
- **Pressing: `details`, as §5 already listed for vinyl.** It is public catalogue data
  and was already in `details` (label, catno, format, year), which round-trips through
  the CSV's `details` column. Added: `country` and `tracklist`, and `label` and `catno`
  now hold every label and catalogue number, not the first. The tracklist is a list of
  tracks and headings, capped at 400 lines; an index track (a suite, a medley) is
  marked `index` and followed by its parts, which are what the track count counts.
- **What goes out.** Share pages show the pressing and the tracklist, folded, on a
  record's page. Connections get what `plainDetails()` has always sent — the plain
  values: label, catalogue number, country, year, format, Discogs id — and not the
  tracklist (or genres), which are lists. Sending them would be a protocol change, an
  older peer's parser drops lists anyway, and the Discogs id it does get finds them.
  No grade goes anywhere outside, and tests compare share pages and the feed, shelf and
  item routes with graded records.
- **Filled on add.** A Discogs search result has no tracklist, so saving one (the
  candidate form marks itself `source=discogs`) fetches its release once, before the
  write; the release's pressing keys replace the search's in `details`, since both came
  from Discogs a moment ago. Publisher, published and length (the track count) fill only
  when blank. A failed fetch adds the record as the search described it. A barcode
  lookup's candidate now carries the scanned code (EAN-13 in `isbn13`, else
  `isbn10_upc`), so the record can be found again. **Amended by #67:** the record's cover is
  not the result's Discogs image (`cover_image`), which the add used to store. It comes from
  the Cover Art Archive, found by that barcode or by a confident artist-and-title match on
  MusicBrainz, or the record has none.
- **Refresh from Discogs: one request per click, blanks only.** It fetches the release by
  `details.discogs_id` when there is one — the full answer — else searches by barcode,
  which gives everything but the tracklist and stores the release id, so the next click
  fetches the tracklist. It writes only `details` keys `discogs_id`, `label`, `catno`,
  `country`, `year`, `format`, `genres`, `tracklist`, and the columns `publisher` (first
  label), `published` (year) and `length` (track count) — each only while blank (absent,
  null, empty text or an empty list). Anything with a value stays, whoever put it there:
  the app keeps no provenance, so "never overwrite a hand edit" is "never overwrite".
  Title, creators, description, cover, barcode, notes and grades are never touched. The
  write is guarded on the four fields it read (`applyPressingFill()`), so an edit saved
  while Discogs was asked wins and the page says to refresh again. A click is the
  session check, one read and one write (3 D1 calls). Discogs' 429 ("busy"), 404, 401
  and timeouts come back as a notice by code, never as text from the URL.
  **Amended (after 1.6.0): it updates in place, with the redirect as the no-script
  fallback.** With `HX-Request` the handler answers 200 whatever the result (htmx swaps
  nothing on an error status): the pressing section's content (`#pressing-body`), and out
  of band the rest of the details with Discogs' credit when that's where it goes
  (`#pressing-more`) and the published, publisher and length rows (`#item-filled`, a
  `display: contents` group in the props list) — everything on the page a fill can change —
  rendered from the row it read plus the fill it wrote, so still 3 D1 calls filled and 2
  otherwise, against 3 + 11 for the redirect and the page reload it replaces. The fixed
  sentence goes out of band into `#discogs-status`, an `<output>` that stays on the page
  beside the button, so a screen reader hears it; the page the no-script redirect lands on
  shows its sentence there too. The button is disabled while the request is out
  (`hx-disabled-elt`) and is never swapped; public/app.js says "Asking Discogs…" in the
  region meanwhile, gives focus back to the button once the answer is in (Chromium drops
  focus from a disabled button to `<body>`), and says a fixed "Something went wrong — try
  again." on a request that ends with nothing to swap (`htmx:responseError`, `sendError`,
  `sendAbort`, `timeout`) — for these forms only (`data-refresh-status`). Focus goes back
  to the button unless it is still inside the form or the person has since focused
  something themselves: a second click on the disabled button leaves it on `<main>`
  (`tabindex="-1"`), which doesn't count. A "changed" answer (the guarded write lost the
  race) reads the record again, on that rare path only (4 D1 calls), so the swapped regions
  show the edit that won rather than the row the click first read. `npm run a11y` drives
  both buttons in a browser (§18).
  Without htmx: the same redirect as before.
- **CPU.** Parsing is one pass over Discogs' JSON with caps on every string; tests keep
  a record's page, with a 400-line tracklist, at the same D1 calls as a book's.
- **Credit (amended by #63).** Wherever this pressing shows, Discogs' terms want "Data
  provided by Discogs." beside it, linked to the release; #63 says where it goes.

**Chosen without asking, overrulable:** grades are for `vinyl` and `music` both; a field
the owner cleared is a blank, which a refresh fills again; a record added before this
keeps the flat format a search gave it, since refresh never replaces a value — clear
`format` in the details box and refresh to take Discogs' fuller one; by barcode a
refresh is two clicks to the tracklist rather than two requests in one click; genres
stay a list and so stay off connections, as before; the refresh never fetches a cover.
