# Nalanda 📚

Self-hosted home library registry for **books, board games, and vinyl records** — and a
**Goodreads replacement** for the reading life around them — running on Cloudflare's free
tier at **$0/month**. Named for the library of the Nalanda mahāvihāra; styled after its
manuscripts.

![A shelf of books in cover view — the manuscript-ledger design system in light mode](docs/screenshots/shelf-covers.png)

- **Scan to shelf**: point your phone camera at a book or record barcode; ISBNs look up
  books (Open Library + Google Books), other barcodes look up vinyl (Discogs). Board games
  add by name search (BoardGameGeek).
- **Reading log, not just a catalog**: books you've read but don't own are first-class
  (`copies = 0`, badged "Not owned") — log a finished book by scanning it and writing the
  review, no shelf space required. A Holding column flips a logged book to owned in one
  click when a copy finally arrives, and back again.
- **Goodreads import**: drop in a Goodreads export CSV — rows matching your shelves merge
  their ratings/reviews onto existing books, and their shelves, read dates and read counts
  become reads; the rest arrive as reading-log entries. Everything it brings is the importing
  member's own. Re-runs merge instead of duplicating, and never remove a read. libib CSV
  import too.
- **Public share links, per view**: publish any filtered slice of a shelf ("my reviews",
  "owned sci-fi"), or everything carrying a tag, at its own unguessable URL — rotate or remove each link independently.
  Private notes, where things are kept, loans, copy counts, what you paid and a record's
  condition never appear. Reviews can link out to blog posts.
  One admin page lists everything you've published, with the item count each link
  exposes.
- **An app on your phone, and scanning with no signal**: install it to your home screen
  (below), and the scanner keeps working in a basement or a bookshop — barcodes are held on
  the phone and listed on **Add items** for you to add or drop once you're back online. No
  page of your catalog is ever stored on the phone.
- **Want lists and gift lists**: each member keeps their own want list — "Want to read" on a
  book, "Want" on a record or game, or straight from a scan or search result, which adds it as
  Not owned. Anyone pastes shop links under "Where to buy". An admin can publish a member's
  list as a gift list: a share link showing exactly what they want now, with those links, and
  their display name only if names are switched on. Finishing a book takes it off your list.
- **Family accounts**: admin + members, no email infrastructure needed.
- **Everyone's own reading and reviews**: each member's reads, pages, rating and review are
  their own, shown under their name on the book's page, and a "Read by" filter narrows a shelf
  to what you (or anyone) have read, or haven't. A book's status on shelves stays the
  household's: Completed once anyone has finished it. Share pages and connections see only the
  household's average rating and latest review, never who wrote it — unless an admin switches
  names on, when each member's rating and review appear under the display name they chose, and
  connected households get a feed entry per person. "Read by" can't be published, and usernames
  never leave the app. Admins can move a read or review credited to the wrong person.
- **Where it lives**: note where each thing is kept — "study, 2nd shelf", "Loft · box 3" —
  and find it again by searching for the place. Private, like notes: never on share pages or
  to connections.
- **Records, properly**: grade each record's media and sleeve on the Goldmine scale Discogs
  uses (Mint to Poor, plus Generic or No Cover for a sleeve) — your copy's condition stays
  inside the app, never on a share page. Scanning or searching a record fills its pressing from
  Discogs: labels, catalogue number, country, year, format (colour vinyl, 180 g, 2×LP) and the
  tracklist, folded on its page; **Refresh from Discogs** fills the blanks for records already on
  your shelves, one request per click, and never changes what you've typed.
- **What you paid**: an optional purchase price on anything — book, game or record — in the
  household's currency, which an admin sets once (₹, $, ¥ — any ISO currency, with its own
  decimals). Each shelf shows what it cost, one total per currency and never converted, and the
  Overview lists every shelf's. Prices stay in the app: never on share pages or to connections,
  and they round-trip through the CSV. (Market values from Discogs were considered and
  dropped: its API terms forbid showing marketplace prices more than six hours old — ARCH.md §16 #61.)
- **Reading goals**: each member sets how many books they mean to finish in a year, and the
  Overview shows their count and pace. Connected households can hear when a goal is set, passes
  halfway and is reached, signed with the member's display name, if the household chooses.
- **Year in review**: pick a year and see your reading beside the household's — books finished
  and pages read month by month, most-read authors and tags, average rating, the highest-rated,
  longest, shortest and fastest reads — and the household's records spun and games played.
  Inside the app only.
- **Loans**: track who borrowed what, with due dates and history — each item's page lists who has had it before, and for how long.
- **Play log for games, listening log for records**: press **Played** on a board game or a
  record — today, or any day you pick — and its page keeps count ("Played 12 times · last on
  14 Sep") with the recent dates. Plays are the household's, not a person's; share pages show
  only the count, and connections see none of it.
- **What should we play tonight?** Say how many players, how much time and what weight (light,
  medium or heavy, from BoardGameGeek's complexity rating), and see the board games on your
  shelves that fit, in random order, each with when you last played it — or press **Pick one
  for us**. Games missing a detail are listed separately rather than hidden. **Refresh from BGG**
  on a game's page fills its weight, player count and playing time where blank, one request per
  click, never changing what you've typed.
- **Connections between households** (optional): connect with another household that
  self-hosts Nalanda — follow each other's reading in a feed, comment on each other's
  reviews, and borrow each other's books with the loan tracked on both sides. One-to-one
  and invite-only, never a network or the fediverse; off unless you give the instance a key.
  **Notifications** count connection requests, borrowing and comments, and Feed counts what's
  new, per person in the household.
- **Formats and editions**: say which forms you hold a work in — hardcover and audiobook, LP and
  CD — filter a shelf by them, and list the other editions' ISBNs so a scan of any of them finds
  the one item. Lending asks which copy went out. One item per work; its reads and reviews stay one.
- **Language and original title**: a household language that every added book takes unless its
  source says otherwise, changeable per item; a pill when a book's differs; and the title a work
  was first published under, in any script, searchable as written.
- **New from your authors**: the authors you've finished, and on a click their works from Open
  Library, newest first, with what you already have marked — the extent of discovery here: no
  recommendation engine, nothing about your reading sent anywhere.
- **Quotes and highlights**: keep the lines worth keeping on each book, with a page and a note
  of your own; private until you mark one to show on share pages. Import your Kindle highlights
  in one go, parsed in your browser, matched to your books.
- **Search operators**: `author:`, `title:`, `tag:`, `status:`, `year:`, `lang:` and `type:` beside
  plain words in the search box — `author:"le guin" status:unread year:1960-1979` — and anything
  the box doesn't understand is searched as text.
- **Saved views**: a shelf's filters under a name, the household's, opened from the shelf or the
  Overview; two decluttering views on every shelf — unread for years, not played lately.
- **Borrowed from someone**: a book borrowed from a friend is a Not owned item with a borrow record —
  who from, due back when, returned — a Borrowed pill, a Holding filter, and a Borrowed page for every
  household; private like loans.
- **Item history**: for admins, each change to an item's own fields with who and when, kept 90
  days — not reads or reviews, which say who already.
- **A trash**: a deleted item waits 30 days with everything it had — reads, reviews, pages,
  plays, loans, tags, cover — and an admin can restore it or let it go. The delete itself is
  still a delete: nothing trashed stays on a share link or in a connection's view.
- **A cover from your camera**: under any item's cover, take a photo or pick a file and make it
  the cover — shrunk in the browser before it's sent, so a phone photo goes up in a second. For
  the old paperback, the Indian edition, the small-press game nobody has an image of.
- **Creators and publishers**: every author, designer and artist the catalog names, grouped by
  which they mostly are, and every publisher and label — each with a page of their items and how
  many you've finished, linked from each item's page. Read from the items as they are: "Le Guin,
  Ursula K." and "Ursula K. Le Guin" are one author.
- **Find a series' gaps**: on a series' page, one click asks Open Library for its volumes and offers
  the numbers you're missing, with your own numbering left exactly as it is.
- **Series**: give a book its series and number ("The Expanse", #3 — or #2.5 for the novella
  between), filled in from Open Library when it knows. Each series shows its volumes in order,
  the numbers you're missing ("#4, #6–9" once you set how many there are), and your own
  **next up** — the lowest-numbered volume *you* haven't finished. Share pages show a book's
  series and number, never the gaps or anyone's reading.
- **Tags, half-star ratings, full-text search** across the collection, plus a quick
  title/author/location filter inside every shelf and sorting by newest, title, rating, or date
  finished.
- **Bulk edit**: tick items on a shelf or in search results, or select a whole page, then tag
  or untag them, move them to another shelf, or mark them owned or not owned, up to 250 at
  a time. Admins can delete in bulk too, after a confirmation that names what goes.
- **Reading progress**: record the page you're on, keep the log of how you got there, and
  see how far through a book you are. Connections follow it in their feed, page by page;
  it stays off public share links unless you choose to show it there.
- **Re-reading**: "Read again" on a finished book starts a new read — the book stays
  Completed, marked re-reading, until you finish or stop it. Every read keeps its own dates
  and pages, and can be corrected, deleted or added after the fact; a book read more than
  once says "Read N times" on share pages, and connections see "re-reading" and "finished
  again".
- **What to read next**: the Overview suggests one book you haven't finished and aren't
  reading, owned or not, whoever else has read it. **Another** draws a different one;
  **Start reading** starts your read and opens the book.
- **Own your data**: every field round-trips through CSV export — each read with its reader,
  each member's review, every loan and every play, want lists and purchase links — and plain-SQLite backups.
- **The manuscript ledger**: a hand-written design system grounded in Nalanda's Pala-era
  scriptorium — palm-leaf paper, indigo and vermilion, Devanagari-first display type,
  a lamp-lit dark mode. No CSS framework.

Stack: TypeScript · Cloudflare Workers · Hono (server-rendered JSX) + htmx · D1 (SQLite) +
Drizzle · R2 for cover art. One deployable, no client build, three runtime dependencies.
See [ARCH.md](ARCH.md) for the design and the reasoning behind it.

## A look around

| | |
|---|---|
| ![The overview page: owned and not-owned counts, shelves with their visibility, loans, recent additions](docs/screenshots/overview.png) | ![A shelf in table view, sorted by date completed: title, type, year, completed, rating, status, holding, tags, accession number](docs/screenshots/shelf-table.png) |
| **Overview** — what's owned, what's only read, what's out on loan, and how public each shelf is. | **The ledger view** — every shelf reads as a catalogue card, down to the accession number. Sort by title, rating, date added or date finished. |
| ![An item page showing cover, catalogue fields, review, and the lending form](docs/screenshots/item.png) | ![A public share page listing finished books, with no sidebar or account links](docs/screenshots/share.png) |
| **An item** — metadata auto-filled from the barcode, your rating and review below it. | **A published share** — one filtered view, its own link. No notes, no loans, no way back into the app. |

Because publishing is the only way anything leaves the app, everything you've published
gets one page — each link's scope, the number of items it exposes right now, and rotate or
remove on the spot:

![The shared links page: two published links, one scoped to finished books, one to a whole shelf](docs/screenshots/shares.png)

Ten columns don't suit every shelf — a vinyl record has no "date finished", a board game
would rather show play time than year — so the table's columns are yours to pick, remembered
per device:

![The Columns dropdown open over the shelf table, with a checkbox per column](docs/screenshots/columns-menu.png)

And a lamp-lit dark mode that follows the system setting:

![The same shelf in dark mode — warm blacks, pigments glowing](docs/screenshots/shelf-dark.png)

Screenshots come from seeded demo data — `npm run dev:demo` and `npm run seed:demo` will
reproduce them on your own machine.

## Local development

```sh
npm install        # also vendors htmx, the ZXing barcode WASM, and fonts into public/vendor/
npm run db:migrate # create the local SQLite database
npm run dev        # http://localhost:8787 → /setup creates the admin account
npm test           # vitest, runs inside the real Workers runtime
npm run lint       # accessibility rules over the views; npm run a11y audits every page in a browser
```

Everything runs offline: local D1 is a real SQLite file, R2 is emulated, and the camera
works on localhost. Local secrets live in `.dev.vars` (copy `.dev.vars.example`).

## Running your own

Everything below fits inside Cloudflare's free tier. One-time setup:

```sh
wrangler d1 create nalanda            # note the id it prints
wrangler r2 bucket create nalanda-covers
wrangler secret put SESSION_SECRET
wrangler secret put DISCOGS_TOKEN     # free — enables vinyl barcode lookup
wrangler secret put BGG_TOKEN         # free once BGG approves your app — board game search (runbooks/deploy.md → API tokens)
wrangler secret put HOME_SHARE_TOKEN  # optional — logged-out "/" redirects to this share
wrangler secret put FEDERATION_PRIVATE_KEY  # optional — turns on connections; see runbooks/connections.md

D1_DATABASE_ID=<the id> npm run deploy   # remote migrations, then wrangler deploy
```

This repo names no Cloudflare resource of its own: `database_id` in `wrangler.jsonc` is an
all-zero placeholder, and the deploy substitutes the real one from `D1_DATABASE_ID`. Local
development, local migrations, and the tests all run against the placeholder, so a fresh
clone works offline with nothing to edit. (`wrangler d1 list` will remind you of the id
later.)

From there `npm run deploy` is every update. Nalanda is released as numbered versions, each with
notes on [GitHub Releases](https://github.com/isstiaung/nalanda/releases) and in
[changelog/](changelog/) (indexed by [CHANGELOG.md](CHANGELOG.md)) that say what an update changes
and whether to back up first;
[runbooks/updating.md](runbooks/updating.md) walks through one. If you'd rather not deploy from your laptop,
point Cloudflare's dashboard git integration at a branch with an empty build command and
`npm run deploy` as the deploy command, and set `D1_DATABASE_ID` as a build variable on
the Worker. Resource setup, custom domains, rollback, and data migration are covered step
by step in [runbooks/deploy.md](runbooks/deploy.md).

## On your phone

Nalanda installs to a phone's home screen and opens full-screen, like an app. Sign in on the
phone first, in the browser, over HTTPS (your `workers.dev` address or custom domain):

- **iPhone / iPad** — in **Safari**, tap **Share** → **Add to Home Screen** → **Add**. The
  home-screen app may keep its own sign-in apart from Safari's, so sign in there too.
- **Android** — in **Chrome**, open the **⋮** menu → **Install app** (or **Add to Home screen**),
  and confirm. Long-press the icon for a **Scan** shortcut.

The camera needs HTTPS, which Cloudflare gives you. With no signal, opening the app shows a
scan-only page; each barcode is held on the phone until you're back online, when **Add items**
lists them for you to add to a shelf or drop. Logging out clears anything still held.

## Operations

| Runbook | When to use it |
|---|---|
| [deploy.md](runbooks/deploy.md) | First deploy, updates, rollback, custom domain, API tokens |
| [backup-and-restore.md](runbooks/backup-and-restore.md) | Routine backups, restoring after a mistake |
| [accounts-and-access.md](runbooks/accounts-and-access.md) | Family accounts, lost passwords, admin lockout, share links |
| [connections.md](runbooks/connections.md) | Connecting with another household's Nalanda: keys, feed, comments, borrowing, disconnecting |
| [import-from-goodreads.md](runbooks/import-from-goodreads.md) | Bringing your Goodreads history over (and leaving) |
| [import-from-libib.md](runbooks/import-from-libib.md) | Migrating your libib collection |
| [metadata-backfill.md](runbooks/metadata-backfill.md) | Filling in covers and descriptions for a large catalog, from your machine |
| [record-covers.md](runbooks/record-covers.md) | Replacing record covers stored from Discogs with the Cover Art Archive's (a one-off) |
| [troubleshooting.md](runbooks/troubleshooting.md) | Scanner, lookups, deploys, logs |

## Data sources

Metadata and covers come from Open Library, Google Books, BoardGameGeek, Discogs and, for
records' covers, MusicBrainz's Cover Art Archive, each under its own terms; if you run an
instance, you are the one using their APIs ([THIRD-PARTY.md](THIRD-PARTY.md)). Their terms ask
for credit beside their data, so a board game's page carries BoardGameGeek's "Powered by BGG"
logo, and a record whose pressing came from Discogs says "Data provided by Discogs.", linked to
that release on discogs.com. Discogs' images are never stored: its terms restrict them.

This application uses Discogs’ API but is not affiliated with, sponsored or endorsed by Discogs. ‘Discogs’ is a trademark of Zink Media, LLC.

Working conventions for future development live in [CLAUDE.md](CLAUDE.md).
