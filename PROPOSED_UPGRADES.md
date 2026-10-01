# Proposed upgrades

A review of Nalanda at v1.6.2 (2026-10-01), asking what is still missing for it to replace
Goodreads and libib for a household. Nothing here is decided: an item becomes work only once
it is picked up, and a scope call either way belongs in ARCH.md §16 as a numbered decision.

Everything proposed stays inside the settled stack and the hard constraints (CLAUDE.md):
Cloudflare free tier, 10 ms CPU, D1 budgeted to 50 calls, no new runtime dependencies, every
new user-visible field round-trips through `/export.csv`, and the share-page whitelist grows
only through `toPublicItem()` after checking ARCH.md §9.

## Where it stands

For a household catalog Nalanda is already past libib in several places: per-view share links
behind a real privacy whitelist, per-member reads and reviews with a household summary,
re-reads, series gaps, want and gift lists, purchase prices, record grading, game night, year
in review, and household-to-household connections with borrowing. The privacy model is the
strongest part of the codebase. The engineering discipline shows too: CSV round-trips, one
batch per write and its side effects, append-only migrations, and an accessibility audit in CI.

The gaps below are of three kinds: things Goodreads has that a reading log needs, things
libib has that a catalog needs, and hygiene a self-hosted multi-user app needs regardless.

## Decisions of 2026-10-01, and the build order

Everything below was decided in one sitting, item by item. Each ships as its own PR with its own
ARCH.md §16 decision (from #75), reviewed by the nalanda-agent session before merge. Deferred
items keep their notes so the thinking isn't redone.

**Build queue, in order:**

1. **Formats and editions** (done: `feat/formats-and-editions`, ARCH §16 #75) — formats as a set (checkbox group; hardcover, paperback, ebook,
   audiobook; LP, 7", CD, cassette; a game's format list), shown as pills, filterable, public like
   the publisher, a `formats` CSV cell, filled from Open Library's physical format. "Also held as":
   extra ISBNs/barcodes per edition (format, ISBN, publisher, year) so a scan of another edition
   finds the item ("In your catalog") instead of a duplicate. One item per work: title, cover,
   series, reads, reviews stay the work's; no per-edition cover, copies or loan. A loan records
   which edition went out (chosen from the item's formats), on the item page, the Loans page and
   in the loans CSV cell. Media types `movie`, `music`, `videogame`, `other` stay in the enum, not built.
2. **Language and original title** (done: `feat/language-and-original-title`, ARCH §16 #76) — a household default language, any ISO 639, English until an
   admin changes it (Members, beside the currency). Every added item takes it unless the provider or
   file says otherwise; editable any time; a pill when an item's differs from the household's.
   Original title: optional free text, any script. Search matches text as written: no transliteration.
   Both public like the publisher, both in the CSV.
3. **Quotes and highlights** (done: `feat/quotes-and-highlights`, ARCH §16 #77; to connections later) — a `quotes` table: item, member, text, optional page, optional note
   (the reader's own words), added when. Added from the book's page, listed there under the member,
   and on a per-member Quotes page. **Per-quote "share" checkbox, off by default**: only a shared
   quote reaches `toPublicItem()`, signed with a display name only while names are on for share
   pages. A `quotes` CSV cell with names as reads carry them. **Kindle import**: `My Clippings.txt`
   and the app's notebook HTML, parsed in the browser and posted as JSON batches; highlights become
   quotes dated by Kindle, a note at the same place becomes the quote's note, bookmarks ignored,
   re-import merges by book and text; matching by the Goodreads title-and-author rule; a book not
   in the catalog is created as a Not owned reading-log entry and the report says which were new.
4. **Discovery, part 1: new from authors you've finished** (done: `feat/new-from-authors`, ARCH §16 #78) — a page that takes your most-finished
   authors (the Creators split rule), asks Open Library's author-works endpoint on click (keyless,
   one request per author, never in the background, cached per isolate for a day) and lists works
   not in the catalog with Add and Want. README says this is the extent of discovery.
5. **Discovery, part 2: a series' gaps** (done: `feat/series-gaps`, ARCH §16 #79; rehearse against the real catalog) — on a series page, "find #4" asks Open Library for the
   series' works and offers the missing numbers to add or want, as Not owned items with the number
   filled. **The household's series data always wins**: Open Library only suggests, never changes a
   name, number or total; where its numbering disagrees, yours stands and the suggestion shows what
   it would have been. Rehearse against the real catalog first. No "readers like you" (deferred).
6. **Search operators** — `author:`, `tag:`, `status:`, `year:`, `lang:` on the search box; FTS5
   column prefixes for the indexed columns, filters for the rest; an unknown prefix is plain text.
7. **Saved filters, the household's** — a `saved_views` table (name, the filter set, who made it);
   any member makes or edits one; listed on the Overview and the shelf's filter bar. Two presets
   ship as the decluttering view: "Unread for years" (owned, unread, added 3+ years ago) and "Not
   played lately". The "Read by" filter is allowed in a saved view (inside the app only).
8. **Borrowed from someone not on Nalanda** — a borrowed book is an item (Not owned; carries reads
   and a review) with a borrow record, the mirror of a loan: lender, borrowed on, due back, returned
   on, note. Pills "Borrowed from Priya, due …" / "Borrowed, returned"; the Loans page gains a
   Borrowed section with overdue flagged; the shelf's Holding filter gains Borrowed beside Owned and
   Not owned. Not tags: a tag can't hold a date. A `borrowed` CSV cell, private like loans: never on
   share pages or to connections. The Borrowed page (connections-only today) becomes the one place
   for both a request to a connected household and a plain "I borrowed this from" entry.
9. **Sort by author surname** — a shelf sort using the first creator's surname (the Goodreads
   matcher's rule plus the Creators split); no creator sorts last.
10. **Item history** — admin-only History on the item page: who changed which of the item's own
    fields (title, cover, shelf, holding …) and when, from the existing update paths, kept 90 days.
    Not reads, reviews or plays, which already show who did them.
11. **Branded QR codes for share links** — on Shared links, a QR per link generated in the browser
    by a small vendored library: lampblack modules on palm-leaf, the Nalanda mark centred with the
    vermilion rule, error correction high enough for the mark, a plain fallback. Nothing new published.
12. **Atom and RSS on share links** — `/share/:token.atom` and `.rss`: recent additions and finishes
    among the link's items (title, creators, household rating and latest review, cover, link to the
    item's share page), same whitelist and names rule as the page, never progress, 20 entries, cached
    with the page. Drawn from the activity log the connections feed already uses.
13. **StoryGraph and LibraryThing imports** — two mappers beside Goodreads', match-and-merge, the
    importing member's own reads and reviews, a runbook and a fixture each.
14. **Read-only token API, per member** — tokens made on the Account page, shown once, revocable,
    stored hashed, bound by id and key, taken down by Sign out other devices. `/api/v1/`: items with
    the shelf's filters, one item with reads and reviews, search, loans, the member's want list and
    goals; JSON, 250 a page. A token sees what its member sees. No writes.
15. **Interface language, step 1 and a bit** — every string into one table, English the source; a
    few widely used languages (Hindi and Tamil first) machine-drafted and marked as such until a
    native reader checks them; anyone can download the strings, translate, and bring them back
    through an admin import (the household's own translation) or a PR (shipped to everyone). The
    interface follows the household default language, overridable per member on Account.
16. **A static demo** — `npm run demo:build` crawls a seeded instance (as the a11y audit does) into
    static HTML on GitHub Pages: every link works, every form is intercepted with "read-only demo",
    a handful of canned searches, no service worker, a banner. A skeletal login page with `demo` /
    `demo` printed on it, checked in the browser, with the usual wrong-password message otherwise,
    and small print saying it isn't security. Republished on release.
17. **Contributor guides** — docs/adding-a-column.md and docs/adding-a-provider.md, one page each,
    the existing rules in walking order, linked from CONTRIBUTING.md.
18. **Rapid batch scanning** — a "Keep scanning" toggle on the Add page: each barcode goes straight
    into the review list the offline queue already uses (a count, a beep, the camera stays open);
    "Add all" posts the list in batches of 25, each resolved by the usual lookup, with a report of
    added / already in the catalog / nothing found (unknown barcodes stay in the list to add by
    hand). Online and offline scanning become one mode. Bare records only: covers and descriptions
    come later from the existing cover backfill, which paces itself, not from 200 provider requests
    in a row.
19. **Custom fields** — an admin defines up to ten household fields under Members (name; type: text,
    yes/no, date); every item form shows them; values in a `custom` JSON column of their own, never
    in `details` (public). **Private by default, with a per-field "show on share pages" switch**;
    a `custom` CSV cell round-trips them; the trash snapshot picks the column up.

**Deferred, with notes:**

- **Reminders (Web Push + a daily cron)** — skipped for now. Would be per-device opt-in on Account;
  due-in-two-days and overdue to the lender, a borrowed book due back, connection activity; VAPID in
  WebCrypto; the first scheduled task the app would have, so it needs an explicit yes.
- **Passkeys** — skipped; part of the auth relook below.
- **Auth relook** — tabled by the owner for a later sitting. Starting points: the admin lockout path
  (a recovery code at setup, or a second admin by default); the single factor; session length and a
  device list; anything structural (Cloudflare Access, an IdP) was rejected early because share routes
  must stay public. I'll write up §8 + #56 + #70 with the options when it comes up.
- **In-app backup** — skipped until there's a deploy button; download-only, every table the backup
  script lists, members without hashes and keys, trash included, restore stays a runbook.
- **Deploy to Cloudflare button** — not now; the `database_id` placeholder and `SESSION_SECRET` are
  the two things its flow must handle.
- **Borrow before you buy across connections** — deferred until connections mature; "On Asha's
  shelves" on the Add page and the Want list from the views already pulled locally.
- **Widgets (embeds for a blog)** — tabled by the owner to think through. The flow as discussed: a
  share link gains "Embed" on Shared links — what to show (the link's items; reading now; last N
  finished), covers or list, 1–12, light/dark/auto — with a preview and one iframe tag (plus a
  script variant that injects it); the iframe page uses the share tokens, no sidebar, no script,
  covers link to item share pages, sandboxing headers, `noindex`, cached with the share pages. The
  whitelist is the page's; progress and names follow the switches. **The limit that binds is
  requests, not reads**: 100,000 Worker requests a day on the free plan, and every host-page view
  is one; so `Cache-Control: public, max-age=3600`, and for static sites a `/share/:token.json` of
  the same whitelisted items fetched at build time (zero requests at read time), with the Embed
  panel saying so. Open: whether to ship the live iframe at all, or only the JSON for build-time use.
- **"Readers like you" across connections** — out.
- **Ownership per item** and **admin recovery without email** — tabled by the owner for the later
  sitting with the auth relook and widgets. (A demo with a real backend is replaced by the static one.)

## As a Goodreads replacement

### Discovery (decided: queue 4 and 5; "readers like you" out)
Goodreads' real hold on people is discovery, and Nalanda has none by design: no "readers also
enjoyed", no new releases from authors you've read, no browsing beyond your own and connected
shelves. Open Library's author-works endpoint could power a "new from authors you've finished"
page with no network and no new secret, one request per click like Refresh from BGG. Whether
this is in scope should be an explicit decision in the README and ARCH.md.

### Author pages (done: `feat/creator-and-publisher-pages`, ARCH §16 #72 — creators and publishers)
Tags and Series each have an index and a page. Authors do not. "Everything by Le Guin in the
house, and which I've read" is a basic Goodreads view, and `creators` is already a column.
Pattern: `routes/series.tsx`. Needs a creators split that agrees with the CSV's.

### Quotes and highlights (decided: queue 3, with the Kindle import)
Goodreads' second most used feature after shelves. `notes` is private and one per item. A
`quotes` table (item, member, page, text, added) fits the per-member pattern of `reviews`, and
can be publishable under the same `names_on_shares` rule, with the same "never a username"
guard. Round-trips as a `quotes` CSV cell like `reviews` does.

### Editions and formats (decided: queue 1 — one item per work)
No hardcover / paperback / ebook / audiobook field, and no notion of "the same work in two
editions": the paperback and the audiobook are two unrelated items. Goodreads and libib both
model this, and `format` is the most common libib column the import drops. Smallest useful
step: a `format` enum column on items, exported, filterable, filled from Open Library's
`physical_format` when known. Grouping editions into works is a bigger decision.

### Language and original title (decided: queue 2)
Two columns, both public catalogue data, both from Open Library and Google Books. They matter
more for an Indian household than for Goodreads' median user.

### Borrow before you buy (deferred until connections mature)
Borrowing exists, but there is no search across every connected household's shelves at once
from the Add page, which is the moment "do they have it?" is asked. Connection views already
hold the data; this is a query across them plus a line on the scan result.

### Reading goals and stats, smaller items (decided: queue 6, 7, 9)
- Sort shelves by author surname (today: newest, title, rating, date finished).
- Search operators: `author:`, `tag:`, `status:`, `year:`. FTS5 column filters make this
  nearly free; today the box takes plain text.
- Saved filters: share links already capture a filter set. The same mechanism pointed inward
  gives members named views, which is what libib's collections and Goodreads' custom shelves
  really are.

## As a libib replacement

### Cover from the phone camera (done: `feat/cover-photo`, ARCH §16 #73)
Covers are URL-only (`coverUrl` on the item form). Old books, Indian editions and anything
Open Library has no image for are stuck with a placeholder. Resize on the client with a canvas
so the Worker never processes an image (10 ms CPU), and put the JPEG straight into R2 through
`storeCover()`'s raster-only check. The service worker already handles offline scans; a held
photo is out of scope. Note that record covers have their own source rule (Cover Art
Archive only, never Discogs, §16 #67): a hand-taken photo is a third source, and the rule
should say whether a later Refresh may replace one. It should not.

### Rapid batch scanning (decided: queue 18)
The offline queue handles it by accident, but there is no explicit "scan 200 books in one go"
mode when online. That is libib's headline feature for first-time cataloguing. Likely shape:
the scanner keeps scanning and queues each code to the review list, online or not, and the
review list adds them in batches of the import's size.

### The media types that are half there (decided: left in, not built)
`MEDIA_TYPES` holds `movie`, `music`, `videogame` and `other`, with no provider, no add path
and no UI. Either wire them (TMDB and IGDB are keyless-capable at low volume; Discogs already
covers CDs, which `music` is for) or remove them. A half-open door is worse than a closed one.
Removing is a migration on the enum and an import rule for files that carry those types.

### Custom fields (decided: queue 19, private by default)
libib has them. A household eventually wants "signed", "edition", "gifted by". `details` is
public and not hand-editable. Options: a small set of editable, exported, private key/value
pairs on the item form, or an editable public `details` with a private sibling. Decide which
side of the whitelist they live on first.

### Ownership per item (tabled)
`added_by` records who typed it in, not whose it is. When a member leaves, "export my books"
needs an owner. `wants` already has the per-member shape to copy, and `deleteUser()` would need
a rule for what happens to an owner's items.

### Item trash with undo (done: `feat/item-trash`, ARCH §16 #74)
Bulk delete confirms, but nothing is recoverable. A `deleted_at` on items (the `comments`
table already has one) with a 30-day admin-only Trash page, excluded from every shelf, share,
connection view, export and FTS. A family member will need this exactly once.

### Per-item history (decided: queue 10)
Who changed the title, when a cover was replaced, when it moved shelves. `activity_log` exists
only to feed connections. An admin-only history on the item page answers "who marked this as
not owned".

### Decluttering view (decided: two saved-filter presets, queue 7)
"Owned, unread, added more than three years ago" and "games not played since 2023". All the
data exists; it wants one page, or saved filters (above) with two presets.

### Imports (decided: queue 13, both)
StoryGraph and LibraryThing both export CSV and both are where people flee Goodreads to. The
Goodreads mapper in `src/lib/csv.ts` is most of the work.

## Accounts and security

### Sign out all devices (done: `feat/sign-out-other-devices`, ARCH §16 #70)
A session is a signed cookie naming the user id and `session_key`, with no list of live
sessions. A lost phone has no remedy short of an admin password reset. A per-user session
counter carried in the cookie and bumped by "Sign out all devices" (and on password change)
is a few lines in `src/lib/auth.ts`.

### Second factor (deferred: auth relook)
Passkeys fit: WebAuthn verification is WebCrypto only (no package), a household enrols few
users, and it removes the one-password weak point under all the share-link privacy work. TOTP
is the fallback if passkeys prove awkward on a self-hoster's domain.

### Admin recovery without email (tabled)
If the only admin forgets their password, the recovery path is `hash-password.mjs` plus a
`wrangler d1 execute`. Fine for the maintainer, frightening for a self-hoster. A documented,
scripted `reset-admin` command, with the usual backup guard, belongs in the accounts runbook.

## Share pages

### Open Graph tags (done: `feat/share-page-link-previews`, ARCH §16 #71)
A share link pasted into WhatsApp or iMessage shows a bare URL. Title, description and the
first cover as `og:image` are already public data; keep `noindex`. The one check: a gift
list's title follows the same display-name rule as the page.

### A feed on a share link (decided: queue 12)
"What has this household finished lately" as Atom at `/share/:token.atom`, under the same
whitelist, is the one piece of Goodreads' social layer that works without an account. The
connections feed already computes the entries; this serves the public subset of them.

### Printable and QR (decided: queue 11, branded)
A shelf's QR code, pointing at its share link, stuck on the physical shelf. Client-side QR
generation keeps the Worker out of it.

## Lending

### Borrowed from a person who is not on Nalanda (decided: queue 8 — an item with a borrow record)
`borrowed_items` models only books borrowed from a connected household. The common case is
"I borrowed this from a friend and must return it", which has no home. It is a loan row with
the direction flipped: lender name, borrowed on, due back, returned on; never part of the
catalog, never shared.

### Reminders (deferred)
Overdue shows on the Overview, and nothing nudges anyone. Email is out by design, but Web Push
is free, VAPID signing is ES256 which WebCrypto does, and the service worker already exists.
"Due in two days" and "connection request" are the two pushes that turn Notifications from a
counter into a feature. A cron trigger (free) can send the daily ones.

## Dates and locale

### Timezones (done: `fix/today-in-the-viewers-zone`, ARCH §16 #69)
`src/lib/dates.ts` writes dates with no timezone handling, and "today" for a finish or a play
is the Worker's clock. A member in Chennai finishing a book at 2 am logs it yesterday. Either
accept the date as the browser's form sends it, or carry the browser's offset with each write
and compute "today" from it. Check every "today" and "yesterday" in queries and in migration
0036's triggers.

### Interface language (decided: queue 15)
`lang="en"` is hard-coded and there is no string table. Given the Nalanda framing, Hindi or
Tamil is the obvious next locale, and a string table is cheaper to introduce now than after
another ten pages. Share pages would carry the household's language.

## Project and ecosystem

### Modularize ARCH.md (done: PR #106)
ARCH.md was 3,577 lines, 2,700 of them §16, the decision log. The log is now one file per
decision under `docs/decisions/`, and §16 is an index of number, date, title and link, so
every existing "ARCH.md §16 #N" citation (590 in src and test, 200 more in the docs) still
resolves. ARCH.md is 966 lines. Next decision is #69.

## Rules for picking one up

- Read the ARCH.md section it touches first; add a §16 decision when a call is made, including
  the call to not do it. New decisions start at #69.
- A new column is not done until `/export.csv` and the import mapping cover it.
- Anything that could reach a share page or a connection goes through the whitelist review in
  ARCH.md §9 and gets a test that compares bytes with and without the new feature.
- One feature, one PR, one changelog entry with its Upgrading block, in
  `changelog/unreleased.md`.
