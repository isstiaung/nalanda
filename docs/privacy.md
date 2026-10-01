# Privacy invariants

The full privacy rules, grouped by the surface they protect. [CLAUDE.md](../CLAUDE.md) lists every
prohibition among them as a terse bullet; this file holds each rule whole, with the code that enforces it
and the reason. ARCH.md §9 is the share-page design, and §16 the decisions cited here. Read the section
for a surface before changing anything it shows to someone outside the household.

## Share pages and published views

- `/share/:token` pages render a **field whitelist** via `toPublicItem()` in
  `src/lib/share.ts` — never add fields there without checking ARCH.md §9.
- **Never** render on share pages: private `notes`, where an item lives (`location`, ARCH.md §16 #51 —
  never published, and never a key of `toPublicItem()` or `toConnectionItem()`), loans/borrowers, the `copies` count,
  a record's condition (`media_condition`, `sleeve_condition`, §16 #55), `added_by`, usernames, reads or their
  dates, whose reads, or links into the authenticated
  app — and nothing per member unless names are switched on (next bullet). (The derived boolean
  `inCollection` — `copies > 0` — *is* whitelisted; it powers the "Not owned" badge. So is
  `readCount`, the household's finishes, only from two on — "Read N times", ARCH.md §16 #41 —
  and only of an item the household owns: **a Not owned item never claims a read** (§16 #13),
  so `toPublicItem()` adds neither `readCount` nor `progress` while `copies` is 0, whatever the
  household read of it — and, on a shared game's or record's page, `playCount`, the household's plays, never a play's
  date or who logged it, §16 #54. And a shared item's page shows its series name and number —
  public catalogue data, like the publisher — only through `toPublicItem(item, { series })`,
  ARCH.md §16 #52: never the numbers missing from a series or anyone's "next up", and not on
  listings or to connections.)
  `rating` and `review` there are the household summary: the average of everyone's ratings
  and the review written last, with no author (§16 #43). Reading progress appears only when an
  admin turns on `site_settings.progress_on_shares` (off by default), and then only for a book
  being read now — in progress, or finished and being read again (`rereading`) — as the
  latest page anyone reading it recorded; `toPublicItem(item, { progress })` omits the key
  otherwise. Share pages get `noindex`.
- **An import never lets a private value into `details`** (`PRIVATE_COLUMNS` in `src/lib/csv.ts`, applied
  by every mapper — libib, Goodreads, StoryGraph, LibraryThing — before the leftover columns are kept there):
  a column by any name the private things travel under — `location`, `notes`, `private_notes`, `comment`,
  the reading dates and `reads`, `reviews`, `loans`, `borrowed`, `plays`, `wanted_by`, `purchase_links`,
  `editions`, `quotes`, the grades, money, `copies`, `added_by` — is mapped onto its own column where the
  mapper can (`location` and `notes` everywhere) and dropped otherwise, never kept. So a Nalanda export that
  lost a column in a spreadsheet and is read as a libib file, or a Goodreads export someone added a Location
  column to, publishes nothing it shouldn't; the preview names the format it read, so a mis-read file is
  noticed. A Nalanda export's own `details` cell is the only way into `details` for that format.
- **The export never hands a spreadsheet a formula** (ARCH.md §16 #91): `csvEscape()` puts `'` before a
  text cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return (and before one starting with
  `'`), and `mapNalandaRow()` strips exactly one on the way back, so the round trip is exact. The one
  text that reaches the export without passing a form is a recommendation's title and creators, copied
  from what a connection sent when a member wants it — a connection can't plant a formula that opens
  with the file.
- **Formats are public, editions' identifiers are not** (ARCH.md §16 #75): `formats` (the forms an
  item is held in) is in `toPublicItem()` like the publisher, on shelves' and gift lists' pages and to
  connections; the `editions` table (another edition's ISBN or barcode, publisher, year) is as private as
  the main ISBN, never a key of `toPublicItem()` or `toConnectionItem()`. The shelf's Format filter is
  the shelf's own: `shareFilters()` doesn't capture it. A loan's `edition` is circulation detail, private
  like the borrower.
- **Language and original title are public** (ARCH.md §16 #76), like the publisher: `language` and
  `originalTitle` are keys of `toPublicItem()`, on gift lists, and to connections.
- **Quotes** (ARCH.md §16 #77) reach a share page one at a time, only those a member marked `shared`,
  as text and page through `toPublicItem(item, { quotes })` — never a note, never an unshared quote,
  never a username; signed with a display name only while `names_on_shares` is on. Not sent to
  connections yet. The Quotes page is inside the app.
- **Link previews** (ARCH.md §16 #71): every share page's Open Graph tags are a `LinkPreview` its
  route builds from `toPublicItem()`/`toGiftItem()` values and the page's own name and count —
  never a field the whitelist keeps back, never a display name while `names_on_shares` is off, and
  none at all on the 404 page. `og:url` is the page's own URL; `og:image` a `/covers/` key the page
  shows. `noindex` stays.
- Share tokens are random 128-bit, **one per published view** (`shares` table — filters, or a
  tag, captured at publish time; `itemMatchesShare()` guards the public item route, and its
  query-side twin `shareFilters()` must stay in step with it; a captured In progress holds a
  re-read too, through `matchesStatus()`/`statusWhere()`, ARCH.md §16 #64).
  Publish/rotate/remove is admin-only; `/shares` (`src/routes/shares.tsx`) is the
  admin-only inventory of everything published. A shelf is only "Shared" when a
  filterless link exposes it entire — `shareVisibility()`, ARCH.md §16 #23. Share pages are memory-cached per isolate for
  1 h (burst shield); every successful mutation clears the handling isolate's cache,
  but rotation can lag up to 1 h on untouched isolates (ARCH.md §16 #19).
- The shelf's **"Read by" filter** (`ReaderFilter` in `src/db/queries.ts`) is never publishable:
  it is deliberately not part of `ItemFilters`, so `shareFilters()`, `itemMatchesShare()` and
  connection views have no room for it, and the publish form carries no field for it. Keep it
  that way — a published "read by ravi" would tell the world who read what.
- A shelf's search box (`ItemFilters.q`) matches `location`, so share links and connection views
  must never capture `q` (`shareFilters()`, `shelfPage()` don't) — a view filtered by "loft" would
  publish where things are kept.
- **A share link's feeds** (ARCH.md §16 #86) — `/share/:token/feed.atom` and `.rss` — carry what
  `toPublicItem()` (or `toGiftItem()`) carries and nothing more, for the link's twenty newest
  items, each dated by the **day** of `added_at` — the day an item was added is public through a
  feed, the time of day never; a gift list's entries are all dated by the day of its newest want,
  never each want's own — never a read, a finish or its date, never progress, never a name. The
  feed is the page's whitelist in another shape.
- **Saved views** (ARCH.md §16 #81) are the shelf's filter bar stored verbatim, so one may hold `q`,
  `readBy` and the decluttering filters (`addedYears`, `unplayedMonths` — `StaleFilter`, outside
  `ItemFilters` like `ReaderFilter`): never a share's source, never a key the publish form carries,
  never sent to connections.
- **Borrows** (ARCH.md §16 #82) — what is borrowed from someone not on Nalanda, the mirror of a loan —
  are as private as loans: the lender, dates and note reach no share page and no connection
  (`toPublicItem()` and `toConnectionItem()` have no key for them), the Borrowed pill is inside the
  app, and the Holding filter's Borrowed choice rides in `StaleFilter`, outside `ItemFilters`, so no
  share link can capture it.
- **Item history** (ARCH.md §16 #84) is admin-only and inside the app: `item_history` holds before and
  after values of an item's own fields — notes and location among them — and who changed them; no
  whitelist has a key for it, and a share page's bytes are unchanged by it.
- **The read-only API** (ARCH.md §16 #88, `/api/v1/…`) is a member's own view, behind their token:
  it returns what that member's pages show — private notes, locations, prices included — to the
  holder of the token and nobody else. It is not a share: no route is public, a cookie never signs
  in there, and a token never signs into the pages. Tokens are kept as hashes, bound to the
  account's key and generation (#56, #70), and die with "Sign out other devices", a password
  change or the member's removal.

## Gift lists, want lists and purchase links

- **Gift lists** (ARCH.md §16 #53) are the one share kind that isn't a shelf: `shares.want_user_id`
  captures one member's **want list as it stands** and nothing else (no shelf, no filters).
  `shareFilters()` carries it as `wantedBy` and `itemMatchesShare(share, item, tags, wanters)`
  checks the item's wanters — the twins must keep agreeing (a test holds every share kind to it).
  They never count towards a shelf's visibility (`shareVisibility()`, `isWholeShelfShare()`).
  Their pages render `toGiftItem()` — title, creators, cover, type, publisher, published, length,
  description, `inCollection` and **purchase links** — built on `toPublicItem()`: no rating,
  review, reviews, read count, progress, tags or details. The title is "A want list", or the
  member's **display name** only while `names_on_shares` is on — never a username.
  Removing a member deletes their wants and their gift lists in `deleteUser()`'s batch.
- **"Wanted"** is a derived boolean — someone's want list holds the item and `copies = 0` — and the
  one public key want lists added: `toPublicItem(item, { wanted })` adds `wanted: true` only when
  asked and only while not owned, and `toConnectionItem(item, { wanted })` passes it to connections
  (shelf cards, item pages, feed entries) the same way — absent otherwise, so every other item's
  bytes are unchanged, and older peers drop the unknown key. Never whose want, never a count. It
  shows wherever "Not owned" does; a peer's `wanted` renders as our own fixed text. A Not owned
  item never claims a read: no status, no read count and no progress reach its share page (above).
- **Purchase links** are pasted, never generated, the item's (any member adds or removes one),
  and **public only on gift lists** — never on a shelf's share page or to connections
  (`toConnectionItem()` has no field for them). `checkPurchaseLink()` (`src/lib/links.ts`) takes
  only an absolute http(s) URL without credentials, on every way in (form, import) and again on
  the way out of a gift list; they render with `target="_blank" rel="noopener noreferrer"`,
  so a share token never reaches a shop. Want lists and links round-trip through `/export.csv`
  (`wanted_by`, `purchase_links`), with names as the reads and reviews cells carry them.

## Names outside the app

- **Names outside the app** (ARCH.md §16 #45) are a member's optional **display name**, never a
  username, and only while an admin has switched them on — two `site_settings` switches. A new
  instance starts with both on (§16 #49: the code's `SITE_DEFAULTS`, used only while there's no
  row); migration 0036 pinned every instance that already had members to what it had, so an upgrade
  never flips one. Tests about names off say so (`upgradedSwitches()` in test/member-helpers.ts).
  `names_on_shares`: a shared book's page adds `reviews` (each member's rating and review, signed
  with their display name or "A member"), still with no reads, no read dates and no "who read it".
  `names_to_connections`: the feed serves one entry per person with `by` (a display name),
  including kind `started`, and an item page adds `reviews`. Resolve names when serving,
  never when recording — `member_activity` rows point at a read, review, page or goal, never a person.
  **With both off, every served byte stays as before**: no `reviews` or `by` key at all, the
  household's `activity_log` stream and ids untouched; tests compare with and without display
  names. Named feed entries go out with ids past `MEMBER_ACTIVITY_BASE`; one stream is valid at a
  time, so named ids fail the removal check once names are off and household ids while they're on.
  A per-person start or finish is recorded only as it happens, dated then — never by a read's dates,
  never backfilled. A per-person entry also carries no `completedOn`: on an entry about one member that
  column is their read's end date, so `toFeedItem()` blanks it whenever the entry is a member's (named or
  not) and `keepForKind()` again on a named one; the household's own `finished` entry still carries the
  item's `completed_on`, as docs/proposals/connections.md §7 describes, so a connection learns when the
  household last finished a book and never when a person did. A rename or removal re-keys that member's entries in its batch
  (`rekeyMemberActivity()`), and a move of a read or review re-keys that one's (`rekeyMoved()`),
  so peers' held copies are withdrawn. Comments, borrow requests and recommendations are
  signed with `outwardName()` — the display name while names go to connections, else "A member",
  never the username. Names other instances send are strings from another instance (below).
  A session signed in with a temporary password (`must_change_password`) can set no display name
  — nor sign out other devices, nor make or revoke a token: `mustChangeMayReach()` in
  `src/index.ts` lets it reach only `GET /account` and `POST /account/password`, since whoever
  holds the temporary password isn't yet shown to be the member, and a name set there would go
  out on share pages with names on.

## Reading goals

- **Reading goals** (ARCH.md §16 #49) never reach a share page. To connections they are per-person
  entries — `goal_set`, `goal_halfway`, `goal_reached`, each `{ by, year, target, count }` and **no
  `item`** — served only while `names_to_connections` *and* `goals_to_connections` are on (the second
  greyed out on Connections while the first is off), and only for a member with a display name: never
  "A member". Their `member_activity` rows point at the goal (`goal_id`), never a person; a milestone
  also keeps the finish that crossed the line (`read_id`, `item_id`), so it goes only to views holding
  that book and goes when that read does, and a set goes to views that can hold books. Recorded only
  as they happen — the goal's own write in `setGoal()`'s batch, or migration 0036's triggers on a
  finish today or yesterday outside an import — never backfilled, and never dated by a read. A changed
  target re-keys the set and withdraws the old milestones; a deleted goal takes its entries; rename,
  removal and the switch re-key them (`rekeyMemberActivity()`, `setGoalsToConnections()`). What counts
  is `goalCountSql()` — a member's finished reads of books ending in the year — and the triggers
  carry it word for word. The goal kinds are the only item-less ones: `parseFeedEntry()` still needs an
  item on every other kind, and 1.3.0's parser (test/fixtures/items-v1.3.0.ts) skips goal entries.

## Connections

- Connections see only `toConnectionItem()` fields (`src/federation/items.ts`, built on
  `toPublicItem()`), and only for items inside a connection view. Availability is a derived
  boolean — never a borrower, due date or copies count, nor where the item is kept (`location`); reading history is a count
  (`readCount`, the household's), never the reads, their dates or their readers; the rating
  and review are the household summary, never a member's name — unless `names_to_connections` is
  on, and then only display names (see above). A view's status filters as the shelf does — In
  progress holds a re-read (§16 #64) — and a view filtered to In progress serves only reading still
  going on (`readingInView()`): no finish or goal milestone, and a reader's start and pages only while
  their read is open, though someone else still reading keeps the book in. Triggers on `items` record
  activity only while a connection view exists (migration 0007), dated by when it happened —
  an import's batch brackets itself with `import_in_progress` so old reads aren't news
  (migration 0021, ARCH.md §16 #40).
- Strings from another instance — household names, view names, feed entries, members' names (`by`, `reviews`), comments,
  recommendations (title, creators, the name it's signed with, the note) —
  render only as escaped text. Every *name* among them — a feed entry's `by`, a review's, a recommender's, a
  comment's author, a borrow requester's, a household's from its descriptor or connect request — is also cleaned
  on the way in as a display name typed here is (`parsePeerName()`, `cleanHouseholdName()`): control and format
  characters out, so a bidi override can't reorder the text around it on the Loans page, in a notification or in a
  loan's borrower, and a name that is nothing but them rejects what carried it. A comment thread is only ever shown to the two households in it. Never put them inside an inline handler such as `onsubmit="confirm('…')"`:
  the browser decodes HTML escapes back into quotes before it runs the script.

## Recommendations

- **Recommendations** (ARCH.md §16 #58) send `toRecommendedItem()` — built on `toConnectionItem()`: id, stamp,
  a view id, media type, title, creators, published, cover key, and `ids` (only `bgg_id`/`discogs_id` from
  details, whole numbers) — plus the note and an `outwardName()`; never a username, the ISBN or barcode
  columns, or anything toConnectionItem() lacks. Only for an item inside a connection view
  (`recommendableItem()`, checked at send time), and only to a household whose descriptor lists `Recommend`
  in `accepts`: 1.5.0 and older refuse a type they don't know (test/fixtures/*-v1.4.0.ts). A new directed
  type follows the same rule — advertise it in `ACCEPTS`, check `peerAccepts()` before queuing. What the
  receiver does with one (want, dismiss) is never sent back — though a wanted item on a shared shelf shows
  there as any item does. Wanting one copies its cover from their `/covers/`: `storeCover()` keeps raster
  types only and follows no redirect for a peer's URL, and `serveCover()` sends a sandboxing CSP, so no
  cover can run script on this origin.

## What describes this household's copy, and money

- A record's **condition** (ARCH.md §16 #55) — its media and sleeve grades — describes this
  household's copy, like `copies`: it is never published, not on share pages and not to
  connections. It lives in its own columns precisely because `details` is public; never move a
  grade into `details`, and an import drops an off-scale grade rather than keeping it there. Its
  **pressing** (label, catno, country, year, format, tracklist) is public catalogue data in
  `details`; connections get its plain values, not the tracklist. Discogs' API terms want
  "Data provided by Discogs." beside it, linked to the release, plus their not-affiliated notice
  (ARCH.md §16 #63): `discogsLink()` in `src/views/attribution.tsx` decides — a record with a
  `discogs_id` and something Discogs filled, never one typed in by hand — and builds the href from
  a numeric release id only (else discogs.com). Never `nofollow` on it.
- **Money is never published** (ARCH.md §16 #61). What was paid (`purchase_price`, integer minor
  units, with `purchase_currency`) is in no whitelist: never on share pages, never to connections,
  never a key of `toPublicItem()` or `toConnectionItem()`. `toPublicItem()` also strips money keys
  (`MONEY_DETAIL_KEYS` in `src/lib/money.ts` — libib's `price`) from the `details` it publishes; never
  move a price into `details`. Money is never a float: parse with `parseMoney()`, sum in SQL as
  `CAST(sum(…) AS TEXT)`, format with `formatMoney()`, and never add two currencies together.

## Covers and the installed app

- `/covers/:key` is intentionally public — keys are random UUIDs; never make them
  enumerable or derived from item data.
- **The service worker never stores a page or an API answer** (ARCH.md §16 #48): only the
  files in `STATIC` in `public/sw.js`, and it leaves `/share/*` entirely alone. Offline scans
  hold a barcode and a time, nothing else, and belong to the account signed in on the device:
  a different account's pages empty the queue, logout empties it, and POST /items refuses a
  held scan's add (`scanOwner`) for anyone else. Bump `VERSION` in sw.js when `STATIC` or its
  behaviour changes.
- **The browser keeps no signed-in answer either** (ARCH.md §16 #48, amended 2026-10-01): every
  response served behind the session middleware carries `Cache-Control: no-store` (set in
  `src/index.ts` after the handler), so Back or a restored tab on a shared device after a logout
  shows no notes, locations, borrowers or minted password; `POST /auth/logout` sends
  `Clear-Site-Data: "cache"`. Share pages, covers, static files and the login page are served
  before that middleware and cache as they did — never add `no-store` to `/share/*`, whose
  per-isolate cache (§16 #19) is a different thing and stays.
