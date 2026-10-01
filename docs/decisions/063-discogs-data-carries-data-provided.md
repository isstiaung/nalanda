# §16 #63 — Discogs' data carries "Data provided by Discogs.", linked to its release, and the terms' notice

**Decided:** 2026-09-30 (Discogs attribution). Cited as `ARCH.md §16 #63`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

v1.5.0 put a record's pressing from Discogs (#55) on its page, on share pages and in
what connections get, with no credit, which Discogs' API Terms of Use require. The live page
(support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use) refuses scripted fetches,
so it was read from the Wayback Machine's copy of 2026-05-30 ("Last Updated: May 27th, 2025").
Its "Discogs Intellectual Property" section asks for two things:
- *"We require You to display the following notice prominently on Your application and any
  other public-facing use of Our API and the Content that You create: "This application uses
  Discogs’ API but is not affiliated with, sponsored or endorsed by Discogs. ‘Discogs’ is a
  trademark of Zink Media, LLC." This notice may be included in Your terms and conditions or
  usage documentation."*
- *"In addition, You must display the following notice directly next to any data You use from
  the Discogs API: “Data provided by Discogs.” The notice must include a hyperlink to the
  discogs.com page that includes the data. The link back must not use any mechanism that
  prevents passing along search engine ranking credit to that page, such as 'nofollow'."*

No logo is asked for, and Discogs' Application Name and Description Policy forbids making its
mark "the most distinctive or prominent feature", so the credit is text: small, muted, below
the data, like BGG's (#44). What was decided:
- **Which records: a release id and something Discogs filled.** `discogsLink()`
  (src/views/attribution.tsx) credits a record (`vinyl`, `music`) whose `details` hold a
  non-blank `discogs_id` and at least one of `label`, `catno`, `country`, `year`, `format`,
  `genres`, `tracklist`. The id is the provenance the schema lacks: every path that writes
  Discogs' data writes the release id with it (a Discogs result since v1, a barcode lookup,
  the add's release fetch, Refresh), and nothing else writes that key but an import bringing a
  file's `details` back, or someone typing an id into the details box, which says the same. A
  record typed in by hand, even with a label and catalogue number, has no id and no credit —
  the credit would be untrue there. An id alone (typed in, not yet refreshed) credits nothing either: there is no
  Discogs data beside it yet. BGG's rule is the media type (#44) because every board game is
  filled from BGG; records aren't, so the rule reads the data.
- **The link is built from digits only.** `releaseIdOf()` (#55) accepts a positive safe integer,
  or a string of up to 15 digits, and the URL is `https://www.discogs.com/release/<id>`. Any
  other `discogs_id` — hand-typed text, a hostile one from a CSV or a connection — links to
  `https://www.discogs.com/`. Nothing from the item but that number reaches the href.
- **Where.** Right below the pressing (after the tracklist, before Refresh) on a record's page
  in the app and on a shared record's page, both through `RecordDetails`; below the plain
  details list when that is where the record's Discogs data is (genres only). On a connected
  household's record, below the details they sent. On the Add page, each Discogs result (search
  or barcode, and the offline review list) carries its own credit linked to its release, and
  the notice follows the results once.
- **Connections: credited on the receiving side.** BGG's credit isn't shown on a peer's
  games (#44): BGG's terms bind "public-facing uses", and the peer fetched the data under its
  own. Discogs' wording is wider — "directly next to any data You use from the Discogs API" —
  and a peer's record page shows exactly that data (label, catalogue number, country, year,
  format) with the release id beside it, so the credit costs nothing and reads true. The
  peer's id is a stranger's string: the link is built from its digits or not at all.
- **The notice: in the app, beside the credit, and in the docs.** The terms let it live in
  "usage documentation", which the README and THIRD-PARTY.md now carry. But each instance's
  share pages are its own public-facing use, and a visitor there never sees the README, so the
  notice goes wherever the credit does, in smaller type below it. Once per Add page's results.
- **Link attributes.** No `nofollow` (or `ugc`, `sponsored`). `rel="noreferrer"`, as BGG's
  link has, so a share page's token never reaches Discogs; it has nothing to do with ranking
  credit. Share pages keep `noindex`, which doesn't stop links being followed. No new tab.
  The link's visible words are the terms' own; hidden words after them tell a screen reader
  where it goes ("This release on discogs.com", or "Discogs home page").
- **Not credited.** Share listings and shelf cards, which show a record's title and artist but
  no pressing — its own page credits it, as #44 left shelf tables to a game's page. Want-list
  pages (#53), whose whitelist carries no details: the credit's link would publish the release
  id they deliberately leave out. The Feed, which shows no pressing. `/api/lookup`, JSON for
  scripts. A record's grades are untouched and stay private (#55). And a record whose
  publisher or date the laptop backfill (#33) filled from a Discogs match: it writes those
  columns, not the release id, so nothing records that they came from Discogs — "Refresh from
  Discogs" stores the id, and the credit, on the next click.
- **Cost.** Rendering only: no migration, no new column, no D1 call, no request to Discogs.
  Tests count a credited record's page, in the app and shared, at a book's D1 calls.

**Open, for the owner:** the same terms say Discogs' Content *"is dynamic and is quickly
outdated. You may not display in any format or to any audience the Content if it is more than
six (6) hours older than the information on Our online properties … You may not cache or store
the Content longer than is necessary to provide a service to Your application’s users."*
Nalanda stores a pressing and shows it indefinitely (#55). The terms also list release titles,
formats, track listings, identifiers and label names as "CC0 Data", *"made available under the
CC0 No Rights Reserved license"*, which suggests the clause is aimed at the restricted data
(marketplace, users, images); the text doesn't say so. Related, and also open: a record's cover
can come from Discogs (a result's `cover_image`, the cover backfill), and the terms class
"Release Images" as Restricted Data, licensed *"limited, personal, non-sublicensable"*, which
may not be transferred *"to any third party"*; Nalanda keeps the image in R2 and serves it on
share pages and to connections. Neither is changed here. **The cover question is settled by
#67:** a record's stored cover now comes only from the Cover Art Archive, and the covers stored
from Discogs are replaced by the archive's or dropped. The six-hour clause stays open.

**Chosen without asking, overrulable:** the notice in the app on every credited page rather
than only in the docs; crediting connections' records; the Add page's per-result credits;
leaving want lists and listings uncredited; a record with only an id uncredited.
