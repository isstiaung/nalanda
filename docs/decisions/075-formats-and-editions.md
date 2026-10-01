# §16 #75 — Formats are a set on the item, editions are facts about it, and a loan says which copy went out: one item per work

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #75`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

There was no hardcover, paperback, ebook or audiobook anywhere, and no way to say that the
paperback on the shelf and the audiobook finished last month are one work: they were two
unrelated items, with two reads, two reviews and a duplicate on every scan of the other
edition's barcode. Goodreads and libib both model editions; `format` is the libib column the
import dropped. The review of 2026-10-01 raised a works-and-editions layer; **the owner
decided** against it, for the simpler shape here: one item per work, the editions it is held
in as metadata on it, and the copy that went out recorded on the loan.

**What was decided:**
- **Formats are a set, not a value.** `items.formats` holds codes from `src/lib/formats.ts` —
  hardcover, paperback, ebook, audiobook; LP, 7", 10", CD, cassette; boxed, expansion,
  print-and-play; and digital — comma-joined in the kind's order, '' for none, so two items
  held the same way compare equal. The item form shows one checkbox group per kind (each
  checkbox named `format-<code>`, so a plain post carries the set) and app.js shows the chosen
  kind's; the item page and share pages show pills beside the type; the shelf gains a Format
  filter (`ItemFilters.formats`, the shelf's own, never captured by a share link). Public
  catalogue data, like the publisher: in `toPublicItem()` as `formats`, on gift lists (what
  someone buying another copy needs), to connections (older households drop the key). Filled
  on add from Open Library's `format` ("Paperback", "Audio CD") and from Discogs' pressing text
  ("2×Vinyl, LP" → LP), never changing what the form said. A `formats` CSV cell round-trips it.
- **"Also held as" are the editions' identifiers**, in an `editions` table (migration 0043):
  format, ISBN or barcode, publisher, year, every one optional, up to twenty per item. Their
  point is the scan: `catalogMatches()` and `existingForWant()` find an item by another edition's
  ISBN too, so the audiobook's barcode shows "In your catalog" instead of adding it again. As
  private as the main ISBN: never on share pages, never to connections. An `editions` CSV cell
  (JSON, as `purchase_links` is written) round-trips them; the trash snapshot carries them and
  a restore brings them back; `updateItemWithTags()` replaces the set when the form sent it and
  leaves it when the form had no such lines (one opened before they existed).
- **A loan says which copy.** `loans.edition` holds one of the item's own format codes, chosen
  on the lend form only when the item is held in more than one form; the item page's
  circulation line, the Loans page and the loans CSV cell (`|edition:`) carry it. `copies`
  already counts the editions, so "copies greater than open loans" decides whether another can
  go out, as before. A loan to a connected household records none: their request names the
  work, not a copy.
- **What stays single.** Title, creators, cover, description, series, reads, reviews, rating,
  copies and location are the work's. No per-edition cover, copies count or loan; a household
  that lends the hardcover and keeps the paperback as two things makes two items, as today.

**What it rules out:** a works table or a self-reference between items (every per-item feature
would have to choose edition or work, and the share whitelist, import, series and creators
pages with it); a single-valued format; editions on share pages or in connection views; a
format on a loan to a connected household.

`test/formats.spec.ts` holds it: the codes per kind and their normalisation; provider mapping
from Open Library's words and Discogs' pressing text; the form's checkboxes and lines on add
and edit, shown back on a refused form; pills on the item page and share pages, and the
"Also held as" list only in the app; the shelf's Format filter; a scan matching another
edition's ISBN; a loan's copy on the lend form, the item page, the Loans page and the loans
cell; the CSV round trip of both cells; the trash restoring editions; and the share whitelist
carrying `formats` and never an edition's identifier.
