# Cataloguing

What Nalanda holds and how things get into it: three kinds of item, three ways to add one, the
providers that fill in the rest, and the fields that describe your copy.

## Three kinds of thing

Books, board games and vinyl records ([#1](../decisions/001-media-types.md)). A shelf holds any mix;
`/setup` makes three to start with — Books, Board games, Vinyl — and you can rename them or add more.
Every item has a title, creators, publisher, year, length, description, tags, private notes, where
it is kept, a cover, and a `details` block for whatever else a provider or a file supplied: a
record's pressing, a game's player count, a column an import didn't recognise. A URL among the
details — a `reviewed_in` pointing at a blog post, say — renders as a link, on share pages too.
Tags are lowercased on the way in; an item takes up to 50.

## Adding

**Add items** has three tabs. **Scan** points the phone's camera at a barcode — or type its digits
into the box beneath, the same lookup, no camera needed. **Search** finds a title by name. **Manual**
is the full form.

**Where a barcode goes.** An EAN-13 starting 978 or 979 — an ISBN — goes to the book providers, Open
Library and Google Books, merged. An ISBN-10 typed in (an X check digit included) goes the same way
and is kept beside the ISBN-13 it stands for, so a later scan of the book's barcode finds it. Any
other EAN or UPC goes to Discogs as a record's barcode. Board games have no barcode lookup —
BoardGameGeek's API has none — so games are found by name.

**Search results** come eight a page, best match first, with **More results** below; each result's
shelf picker starts on the shelf that already holds most of its type
([#66](../decisions/066-name-search-comes-eight-results.md)). A result the catalog already has — a
book by ISBN (another edition's included), a record by barcode or Discogs id, a game by BGG id —
says **In your catalog**, with a link. Every result offers three things: **Add to shelf**;
**Log — not owned** ([#15](../decisions/015-log-owned-scan-search-results.md)), which adds it with
no copies and opens the edit form so the rating, review and read date go in at once; and **Want**,
which puts it on your want list ([reading.md](reading.md#want-lists)).

**The scanner** uses the browser's own barcode detector where it has one (EAN-13, UPC-A, EAN-8) and
otherwise the vendored ZXing decoder, served from your instance, never a CDN. The camera needs HTTPS
or localhost. It keeps working without a signal: [on-your-phone.md](on-your-phone.md).

## Providers

| Source | For | Needs |
|---|---|---|
| Open Library | books: metadata, covers, language, series, format; an author's works; a series' volumes | nothing |
| Google Books | books, merged with Open Library's answer; most descriptions in a backfill | nothing; `GOOGLE_BOOKS_KEY` raises the quota |
| BoardGameGeek XML API2 | board games by name: players, playing time, weight, description; **Refresh from BGG** | `BGG_TOKEN` — registration-only since 2025, each application approved by BGG |
| Discogs | records by barcode or name: the pressing; **Refresh from Discogs** | `DISCOGS_TOKEN`, free |
| MusicBrainz + Cover Art Archive | a record's cover, by barcode or a confident artist-and-title match | nothing; one request a second |
| iTunes Search | book covers, in the backfill's exact pass | nothing |

Without a token the lookup shows a notice and the manual form still works.
[runbooks/deploy.md → API tokens](../../runbooks/deploy.md#api-tokens) says how to get each;
[runbooks/troubleshooting.md](../../runbooks/troubleshooting.md) covers lookups that fail. Their
terms ask for credit beside their data: a board game's page carries BGG's "Powered by BGG" logo
([#44](../decisions/044-boardgamegeeks-powered-bgg-logo-sits.md)), and a record whose pressing came
from Discogs says "Data provided by Discogs.", linked to its release
([#63](../decisions/063-discogs-data-carries-data-provided.md)). What each provider's data may be
used for is in [THIRD-PARTY.md](../../THIRD-PARTY.md).

## Owned, or only logged

`copies` says how many you hold, and **0 means catalogued but not owned**
([#13](../decisions/013-copies-0-means-catalog-physical.md)): a Goodreads history, a library book, a
book read at a friend's. Such an item carries a **Not owned** badge everywhere, share pages
included, can't be lent, and still takes reads, a rating and a review like any other. The
**Holding** column on a shelf flips an item between 0 and 1 in one click when a copy arrives or
goes ([#27](../decisions/027-holding-own-column-toggle-spans.md)); an item held in two or more
copies shows the count instead, and its edit form changes it. A copy out on loan stays yours until
it is marked returned, and an item borrowed from someone stays theirs ([lending.md](lending.md)).

## Covers

A cover comes with the provider's record, from a URL pasted on the form, or **from your camera**:
under any item's cover, **Add a cover from a photo** takes a picture or picks a file, and **Use
this photo** makes it the cover ([#73](../decisions/073-cover-from-the-camera.md)). The browser
shrinks the picture first (1,200 px on its long side, as a JPEG), so a phone photo goes up in a
second; the server keeps only real JPEG, PNG, GIF, WebP or AVIF files, up to 4 MB, read by their
bytes rather than their name. **Remove cover** sits beside it. Covers live in R2 and are served at
`/covers/<random key>` — public by design, since share pages show them, and unguessable.

**A record's cover never comes from Discogs**
([#67](../decisions/067-records-stored-cover-comes-cover.md)): Discogs' terms restrict its images,
so a record's stored cover comes from the Cover Art Archive, found through MusicBrainz by barcode
or by a confident artist-and-title match, or the record has none. A Discogs image URL pasted into
the form is refused, with the reason; the Add page still previews Discogs' image while you choose.
Covers stored from Discogs before this rule are replaced or dropped by a one-off run from your
machine: [runbooks/record-covers.md](../../runbooks/record-covers.md).

**The backfill.** An import brings no covers, and often no descriptions. **Import / export → Cover
backfill** walks every item missing either, in small batches with live progress
([#8](../decisions/008-cover-backfill-shipped-v1.md),
[#32](../decisions/032-backfill-fills-details-just-covers.md)): first by ISBN or barcode, then by
title and author. A cover is stored only when the source's title or identifiers agree with the item
([#9](../decisions/009-backfill-extended-title-author-pass.md)) — a different edition's cover may be
used, never a different book's — and the record that yields it also fills an empty description,
publisher, year or page count, never what you wrote. Placeholder images are refused. For a catalog
of hundreds, or when the in-app run keeps tripping the free plan's per-request limits, the same
matching code runs from your laptop
([#33](../decisions/033-bulk-backfills-run-laptop-using.md),
[runbooks/metadata-backfill.md](../../runbooks/metadata-backfill.md)).

## Formats and editions

Every item can say which forms it is held in — hardcover, paperback, ebook, audiobook; LP, 7", 10",
CD, cassette; boxed, expansion, print-and-play; digital — as **Held as** checkboxes on its form,
pills beside its type, and a **Format** filter on every shelf
([#75](../decisions/075-formats-and-editions.md)). A book from Open Library and a record from Discogs
arrive with the form the provider named. **Also held as** lists the other editions you hold or have
scanned — format, ISBN or barcode, publisher, year, up to twenty — so a scan of the audiobook's
barcode finds the paperback's item instead of adding it again. One item per work: its reads,
reviews, series and cover stay one. Formats are public (a gift list needs them); an edition's
identifiers are as private as the main ISBN. An item held in more than one form is asked which copy
went out when it is lent ([lending.md](lending.md)).

## Language and original title

An admin sets the household's language under **Members** (English to begin with); every item added
takes it unless its source said otherwise — Open Library and Google Books name a book's language, a
Nalanda export carries it — and any item's can be changed on its form
([#76](../decisions/076-language-and-original-title.md)). A pill shows beside the type only when an
item's language differs from the household's, so a shelf of one language stays plain. **Original
title** is the title a work was first published under, in any script, shown under the title and
found by search exactly as written — no transliteration. Both are public, like the publisher, and
both round-trip through the CSV.

## Series

A book — or anything — can belong to a series with a number in it: "The Expanse", #3, or #2.5 for
the novella between, or no number ([#52](../decisions/052-item-can-belong-series-series.md)). The
form suggests the series you already have; adding by scan or search fills it in when Open Library
knows it (it does for many popular series; Google Books never names one). A name differing only in
case or spacing is the same series. A book's page shows its series as a strip of numbers — held,
this one, finished by you, missing — and **next up for you**, the lowest-numbered volume you haven't
finished, by your own reads. **Series** in the sidebar lists every series with what you hold and
what's missing; a series' page orders the volumes with the gaps in their places, renames (a name
another series has merges the two) and sets how many volumes there are, after which the numbers past
your last show as missing too. One click there asks Open Library for the missing volumes
([reading.md](reading.md#finding-more-to-read)). A share page shows a book's series name and number,
never the gaps or anyone's next up. The CSV carries `series`, `series_number` and `series_total`.

## Where it lives

A free-text **Location** on any item — "study, 2nd shelf", "Loft · box 3" — shown on its page and
found by search and by a shelf's search box ([#51](../decisions/051-items-location-free-text-column.md)).
Private like notes: never on a share page, never to a connection, and no published view can be
filtered by it.

## What you paid

An optional purchase price on anything, in the household's currency, which an admin sets once under
**Members** — any ISO 4217 code, with its own decimals
([#61](../decisions/061-what-was-paid-integer-number.md)). A shelf's page says what it cost, one total
per currency and never converted, and the Overview's shelf table gains a Paid column once anything
is priced. Changing the currency later converts nothing. Prices stay in the app — never on share
pages or to connections, and a libib `price` that landed in details is stripped from anything
published — and round-trip through the CSV as `purchase_price` and `purchase_currency`. A record's
market value from Discogs was considered and dropped: its API terms forbid showing marketplace
prices more than six hours old.

## Records

**Condition.** Grade a record's media and sleeve on the Goldmine scale Discogs uses — Mint to Poor,
plus Generic or No Cover for a sleeve — on its edit form
([#55](../decisions/055-records-grades-private-columns-pressing.md)). The grades describe your copy,
so like the copies count they never reach a share page or a connection; an import drops a grade off
the scale rather than keep it.

**Pressing.** A record added from a Discogs result keeps its labels, catalogue numbers, country,
year, format ("2×Vinyl, LP, Album, 180 Gram") and tracklist, folded on its page; a scanned record
keeps its barcode. **Refresh from Discogs** fills the blanks for records already here — one request
per click, by release id or else by barcode, never changing a value that's there, your own typing
included. The pressing is public catalogue data: share pages show it with the tracklist;
connections get the plain fields, not the tracklist. Wherever it shows, "Data provided by Discogs."
links to the release ([#63](../decisions/063-discogs-data-carries-data-provided.md)).

## Board games

A game added from BoardGameGeek keeps its player count, playing time and weight (BGG's complexity
rating, 1 to 5) with its description ([#60](../decisions/060-what-should-we-play-tonight.md)).
**Refresh from BGG** on a game's page fills those where blank, by its BGG id, one request per click
a few seconds apart, never changing what you typed. They are what game night filters on
([reading.md](reading.md#plays-and-game-night)). The "Powered by BGG" logo sits beside BGG's data,
as its terms require.

## Custom fields

An admin defines up to ten fields of the household's own under Members — a line of text, a yes/no,
or a date; "Signed", "Gifted by", "Bought on" — and every item form shows them. Values live in a
column of their own, never in the item's public details, and stay private unless a field's own
**Show on share pages** switch is on, when the share item page shows that field by name; nothing
of them ever reaches a connected household. They round-trip through the CSV as a `custom` cell
keyed by field name, so a file moves between households, and a deleted field takes its values
with it, named in the item's history ([#95](../decisions/095-custom-fields.md),
[runbooks/accounts-and-access.md → Custom fields](../../runbooks/accounts-and-access.md)).
