# §16 #53 — Each member has a want list; the household pastes purchase links; an admin can publish one member's list as a gift list

**Decided:** 2026-09-30 (want to read). Cited as `ARCH.md §16 #53`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner asked for "want to read", deciding each point:
- **Want lists are per member** — `wants`, one row per member per item, with when it was wanted.
  A "Want to read" toggle on a book's page ("Want" on a record's or a game's) puts it on the
  signed-in member's own list or takes it off; the route takes no member, so nobody changes
  anyone else's list, admins included. The same option sits on every scan and search result
  beside "Log — not owned", reusing that flow: a result not yet in the catalog joins it as Not
  owned (`copies = 0`, #13), the want in the insert's batch (#39); a result whose ISBN-13 is
  already here puts the want on that item rather than adding a second copy. Each member's list
  is a page (**Want list**, newest first), and the household can look at one another's — inside
  the app, as reads are.
- **Purchase links are pasted, never generated**: `purchase_links`, a label and a URL, belonging
  to the item and shared by the household — any member adds or removes one, up to 20 an item,
  an address once. `checkPurchaseLink()` takes only an absolute `http:` or `https:` URL, as the
  WHATWG parser reads it, with a host and no user name or password (a pasted login would go
  public with it), at most 2,000 characters; so `javascript:`, `data:`, relative and
  protocol-relative addresses never reach the table, from the form or from an import. They render
  as text inside `<a href>` with `target="_blank" rel="noopener noreferrer"`: the shop's page
  can't script this one, and is never told where it came from — a gift list's token stays out
  of every shop's logs. A gift list re-checks each link on the way out, so a row that got past
  the route (a hand-edited restore) still can't publish anything but http(s).
- **A gift list is a share, and not a shelf.** `shares.want_user_id` names the member; its other
  filters are unset and no shelf is captured. `shareFilters()` carries it as `wantedBy` — an
  `EXISTS` on `wants` in the same WHERE listings and counts use — and `itemMatchesShare()` gained
  a `wanters` argument, the ids of the members who want the item, which the public item route
  reads in the same batch as its tags, so every id costs the same work as before (#43's timing
  rule). Both read the list **as it stands**: an item taken off, or finished, leaves the page and
  its id stops answering. A test holds the twins together over every kind of share. It is created,
  rotated and removed as any share, admin-only, from the member's Want list page or `/shares`,
  which names whose list it is (by username — that page is inside the app). The publish form
  carries a stamp of the member's account (`giftListStamp()`, over `accountIdentity()`, #56) beside
  their id and both must match, since a removed member's id is reused (the adversarial pass
  published a newcomer's list from a stale form; a username match, the first fix, could be reused too). `isWholeShelfShare()`
  is false for it and `shareVisibility()` leaves it out, so it never makes a shelf read *Shared*.
- **What a gift list shows** is `toGiftItem()`, built on `toPublicItem()` like `toConnectionItem()`:
  title, creators, cover, type, publisher, published, length, description, `inCollection` (as
  "On the shelves", so a giver can skip what the household has) and the purchase links. Less than
  a shelf's share page — no rating, review, reviews, read count, progress, tags or details: a
  gift list is for buying, and nothing about reading belongs on it. Its title is "A want list";
  with `names_on_shares` on and a display name set it is "Priya's want list" (#45) — never a
  username, resolved when served, so switching names off hides it from the next render. There is
  no admin-given name: `shares.name` holds "Want list" and is never shown publicly.
- **Purchase links are public only on gift lists** — the owner left ordinary shelf shares open;
  **chosen: not on them.** A shelf's link says what the household has, and "buy it here" beside
  books already owned is noise at best and an advertisement at worst; the whitelist grows only
  where a need was stated. Connections don't get them either: `toConnectionItem()` has no field.
- **Finishing a book takes it off its reader's want list — chosen, as the owner leaned.** "Want to
  read" is a wish not yet met, and a stale one would keep a finished book on a gift list for
  someone to buy. It is the moment of finishing that clears it: Finish on an open read
  (`closeRead`, straight after its UPDATE, guarded by `changes()` so a refused finish clears
  nothing), correcting an open read to Completed (`updateRead`, on the UPDATE's own conditions —
  found by the adversarial pass), and the edit form's Completed on a book the editor hadn't
  finished — only the reader's, only a book (a record or a game "Completed" was heard or played,
  which isn't having it). Not a stop (they still mean to read it), not a past read added from the
  book's page or a correction of a closed read (history, not a finish now), not an import (so the
  export round-trips), and not someone else's finish. A want added to a book you've finished — to read it again — stays until that re-read
  is finished.
- **Removing a member clears their want list — chosen.** Reads and reviews are the household's
  history and stay unattributed (#43); a want is a wish for later, and a nobody's wish means
  nothing. So `deleteUser()` deletes their wants and every gift list of them in its batch —
  `shares.want_user_id` has no ON DELETE (drizzle-kit drops it on ALTER TABLE, as with
  `reads.reader_id`), and a test fails with "FOREIGN KEY constraint failed" without it. The
  items and their purchase links stay. Deleting an item cascades both.
- **Export and import.** Two columns: `wanted_by` — `since@username` per want, semicolon-
  separated, the name percent-encoded as the reads cell's `@reader` (#43) — and `purchase_links`,
  JSON `[{label, url}]`. The import follows #43: in an admin's import a name that is a member
  here keeps them and any other name is the importer's; a member's import is all theirs; a want
  has no former member (an empty name is nobody's and is dropped). Two names landing on one
  person keep the earliest date. Every imported link is checked as a pasted one; a libib or
  Goodreads file never puts either column into details, which share pages render. The preview
  counts wants per name, only when a file has any.
- **A "Wanted" badge — the owner's call, after the first build.** A wanted item added from a
  result lands on a shelf as Not owned, so it shows on that shelf's share links and connection
  views; the owner chose to keep it there and say why it's there. `wanted` is a derived boolean —
  someone's want list holds the item and `copies = 0` — never whose, and gone once nobody wants it
  or the household has a copy. It shows wherever "Not owned" does: shelves, tags and search
  (`shelfFlags()`, one call with the loans it replaces), the item page, share lists
  (`wantedAmong()`, one call) and share item pages (from the wanters the route already reads).
  `toPublicItem(item, { wanted })` gains that one key, `wanted: true`, only when asked and only
  while not owned, so every other page serializes as before. Connections get it through
  `toConnectionItem()` on shelf cards, item pages and feed entries, only when true — the protocol
  stays version 1: an older household's parser keeps the fields it knows and drops it (a test runs
  the pre-names parser in `test/fixtures/` over it), and this one rejects a malformed value as it
  does any malformed field, and ignores it beside an owned item. Their Wanted renders here as our
  own fixed text. A feed entry keeps the badge it was pulled with, as it keeps `inCollection`.
- **No claim that it was read.** A Not owned item's share page said "read, not on these shelves",
  which a wanted book — or a Goodreads to-read entry — never was; share pages carry no status to
  decide it by, and adding one would widen the whitelist. It now says "wanted, not on these
  shelves yet" beside the badge, else "in the catalogue, not on these shelves"; a connection's
  item page likewise ("Wanted, not on their shelves yet" / "In their catalogue, not on their
  shelves").
- **"Want" finds records and games too**, as books by ISBN-13: a record by its barcode (in
  `isbn13` or `isbn10_upc`) or Discogs release id, a board game by its BGG id (`details.bgg_id`,
  compared as text) — `existingForWant()`, one query. A record scanned by its barcode now keeps it
  on the result (`isbn10_upc`), since Discogs' answer doesn't carry it.
- **The export reads a page's cells in one call.** Tags, reading log, reads, reviews, loans (#57),
  plays (#54), series (#52), wants and links for a page's id range are one batch
  (`exportCellsForIdRange()`, nine statements). Each is the statement its single-purpose twin runs —
  reads, reviews, loans and plays share their SQL with `readsForIdRange()` and its neighbours, and
  a test holds the two paths to the same rows — and the loans statement keeps #57's page cap
  exactly: the same `LIMIT`, the same cut at the last item whose loans all fit, and an item with
  more than a page's worth still goes out alone, its loans read by `loansForIdRange()` in a third
  call. Series are those of the items in the range, which are exactly the page's. So a page is two
  calls — its items and the batch — where it was eight after loans, plays and series, and would
  have been nine with want lists; the streamed export of today's 1,999 items (one page of 2,000)
  measures 5 calls in all, the Export button's page 5 too, and the stream stays inside the 50-call
  budget (#37) to about 22 pages, 44,000 items — the free plan's CPU binds long before.
- **Not built: "bought it".** A marker so two givers don't buy the same thing wasn't asked for; it
  would need a public write, which share links have never had. A possible follow-up.

**Migration 0037_want-to-read**, one generated migration: `CREATE TABLE wants`, `CREATE TABLE
purchase_links`, two indexes, `ALTER TABLE shares ADD want_user_id`. No data changes. It was 0028
until 1.4.0's session keys and the location, series, vinyl, plays and goals migrations took
0028–0036, and was regenerated from the unchanged schema; `drizzle-kit generate` then reports
nothing to do. Rehearsed on a local copy of production's backup of 2026-09-30 (0000–0029, the
per-table restore in `TABLES` order — read from backup.mjs as text; the backup predates `series`,
`plays` and `reading_goals`, so those were skipped — then 0030–0036, then 0037) in throwaway local
state: 0037 left all 37 existing tables identical — the FTS index's own among them, `shares` in
every pre-existing column — with 1,999 items, 381 reads, 359 reviews, 3 shares and 2 users; the 17
triggers unchanged, no foreign-key violations, integrity ok; `wants` and `purchase_links` empty and
`want_user_id` NULL on every share. D1, by test: a gift list 4 calls (either page, 70 wanted items
with two links each), a gift item 7 (the shelf route's own 6 — the same work for every id, so a
hit can't be told from a miss — and one for its links and name), a want-list page 9 for an admin, a
book's page 11, the Overview's Read next card none extra (budget 50, #37). The item page reads its
want list and links in its reading log's batch (`itemPageLog()`), so want lists add no call there.
A gift-list publish form names its member by `giftListStamp()`, an HMAC over the account's
identity (#56), since ids are reused.

**Chosen without asking, overrulable:** the gift list is sorted by title and the
member's page newest-wanted first; "On the shelves" marks a wanted item the household owns
rather than hiding it, since the owner asked for the member's list exactly; the gift item page
keeps the description; links cap at 20 an item and labels at 60 characters, and an empty label
is the site's host; a gift list's link to one of its items stays inside the share.
