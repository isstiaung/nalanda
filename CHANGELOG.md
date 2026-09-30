# Changelog

Every release of Nalanda, newest first. Versions follow [Semantic Versioning](https://semver.org/):

- a **patch** release (1.1.x) fixes bugs;
- a **minor** release (1.x.0) adds features, and may carry database migrations that apply on their own when you deploy;
- a **major** release (x.0.0) needs something from you beyond deploying, or breaks compatibility with connected households on older versions.

Each release has an **Upgrading** section. Read it for every version between yours and the one you're moving to. [runbooks/updating.md](runbooks/updating.md) walks through an update. Your running version is on the **Account** page.

## [Unreleased]

### Changed
- **Refresh from Discogs and Refresh from BGG update the page in place.** A click no longer reloads the whole page and jumps to the section: the pressing (or the game's details) changes where it is, along with the publisher, published year and length above it when the refresh filled them, and the result's message appears right above the button, the same sentence as before, and is read out by screen readers. While Discogs or BoardGameGeek is being asked, the button is greyed out and the message says "Asking Discogs…" or "Asking BGG…", so a second click can't slip through. If the request fails outright, it says "Something went wrong — try again." instead of doing nothing. With JavaScript off, the buttons work as before. No migration and no new secret: nothing to do when upgrading.
- **A book being read again counts as In progress.** Status = **In progress** now lists every book someone in the household is reading, including one finished before and being read again, or one someone else finished that you're reading now. It still also counts as **Completed**, since it was finished; ticking both lists it once. This applies everywhere a status is filtered: shelves, share links and connection views filtered to In progress now include re-reads.
- **A re-read's status says "Re-reading"** instead of "Completed" on shelves and on its page, so it doesn't look finished in an In progress list. Share pages and connected households still see no status.
- **A connection view filtered to In progress shows only reading still going on.** It never sends a finish or a reading-goal milestone, so a book entering it because someone started reading it again doesn't bring an old finish along as news. When one person finishes or stops a book, their start and pages are taken back from households following the view, as they always were — even if the book stays in the view because someone else in your household is still reading it. Starting, finishing or stopping a re-read sends what reading a book for the first time does.

### Upgrading
- **No migration and no new secret.** Nothing is stored differently: the change is in how status filters read what's there.
- **Share links and connection views filtered to In progress grow** to include books being read again. Check **Shared links** and **Connections** if that matters to you.
- **Connections:** nothing changes on the wire. Households on 1.6.0 or older following your In progress views simply see the re-reads in them; their own In progress views keep the old meaning until they update.

## [1.6.0] - 2026-09-30

Year in review, game night, recommendations between connected households, what you paid for things, a sidebar in sections, an accessibility audit in CI, and Discogs' credit beside a record's pressing.

### Added
- **Year in review.** A new **Year in review** page in the sidebar shows a year of your reading beside the household's: books finished (a re-read counts again) and pages read, with a month-by-month chart; most-read authors and most-used tags; the average rating given, the highest-rated books, the longest and shortest book and the fastest read. The household's records spun and games played, with the most played of each, show once below. Pick any year with a finished book or a play, or this one. A book counts in the year it was finished; finishes with no date count in no year, and the page says how many there are. It's inside the app only: share pages and connected households never see it.
- **What should we play tonight?** A new page, linked from the Overview and from any shelf showing board games, for game night: say how many players, how much time you have and what weight (light, medium or heavy, from BoardGameGeek's complexity rating: light below 2, medium 2 to under 3, heavy 3 and up), and it lists the board games on your shelves that fit, in random order, each with when it was last played. **Pick one for us** picks one of them at random, and **Pick another** picks again. A game fits the time only if its longest playing time does. Games missing a detail you asked about are listed under **Not enough details** instead of being hidden. Games out on loan, and games you don't own, are left out. The page is inside the app only; share pages and connected households don't see it.
- **Board games keep BGG's weight.** A game added from a BoardGameGeek search now keeps its complexity rating ("Weight (1–5)", such as 2.29) with its players and playing time. It is catalogue data like those: it shows on the game's page and on share pages, and goes out and comes back in the CSV's `details` column.
- **Refresh from BGG** on a board game's page fills its weight, player count and playing time for games already in your catalog, using its BoardGameGeek id (`bgg_id` in details). One request per click, a few seconds apart; it fills only what's blank and never changes a value that's there, including anything you typed yourself. Needs the `BGG_TOKEN` secret, as search does.
- **Recommend to a connected household.** An item's page has **Recommend to…**: pick a connected household, add a note if you like, and send. Any member can. Only items on a shelf you share with connections can be recommended, so it never shows them anything your shared shelves don't. They see the item as your shared shelves show it, your note, and your display name while names go to connections ("A member" otherwise), never your username. The page says whether it arrived, is waiting for their library to come back online, or was turned away. Each item goes to each household once.
- **Recommended to you.** **Recommended** in the sidebar lists what connected households recommend to you, with the cover, their note and who sent it, and a notification says when one arrives. Anyone in the household can **Add to my want list** or **Dismiss** it; either way it leaves the list for everyone. Adding makes it a Not owned item on the shelf you choose, with its cover, or puts the want on the copy you already have (a game by its BGG id, a record by its Discogs id, or a book an earlier recommendation of it already added). The household that sent it gets no reply either way, though an item on a shelf you share with them shows there as any item does, Not owned and Wanted included.
- **Limits:** a note is up to 500 characters. From one household you take at most 20 recommendations a day and keep at most 50 waiting; past that theirs are turned away until you dismiss some. Dismiss is the only way to turn one down; disconnecting removes all of theirs.
- **Covers are kept only as ordinary images** (JPEG, PNG, GIF, WebP, AVIF), wherever they come from, and every cover is served so that it can only ever display as an image. A cover that is anything else is left out and the item gets the usual placeholder, and so is a connected household's cover that doesn't say what type it is.
- **Export:** recommendations, sent and received, are in **Borrowed → Export connections data**, not in `/export.csv`, which holds your own items.
- **What you paid.** Every item — book, board game, record, anything — can have a **purchase price**, on the item form when you add it by hand or edit it. It's entered in the household's currency, shown on the item's page ("Paid ₹499"), and private: share pages and connected households never see it.
- **A household currency**, set once by an admin under **Members → Household currency** (INR, USD, JPY — any ISO 4217 currency). Prices are entered in it, with its decimals: two for rupees and dollars, none for yen. Until it's set, the item form says so instead of offering a price. Changing it later converts nothing: prices already entered keep the currency they were entered in.
- **What each shelf cost.** A shelf's page says what the household paid for it ("Paid ₹30,200 for 9 — of 12 records on this shelf"), and the Overview's shelf table gains a **Paid** column. Each currency is totalled on its own, never added to another.
- **Purchase prices leave and come back through the CSV**, in two new columns, `purchase_price` (like `302.50`) and `purchase_currency` (like `INR`). A libib file's `price` column becomes the purchase price, in the household's currency, when one is set before you import.
- **An accessibility audit, in CI.** `npm run lint` checks the views against eslint-plugin-jsx-a11y's strict rules, and `npm run a11y` runs axe-core (WCAG 2.2 A and AA) on every page in a real browser, light and dark, desktop and phone width, including the pages htmx changes in place, and walks each page with the keyboard. Both run on every pull request. For contributors only: nothing new is deployed.
- **A "Skip to content" link** is the first thing Tab reaches on every page, so keyboard users no longer go through the whole sidebar each time.

### Changed
- **The sidebar folds into sections.** Overview, Add items and Search stay at the top. Everything else is grouped by what you came to do: **Library** (Tags, Series), **Shelves**, **Reading** (Want list, Reading goals, Year in review), **Lending** (Loans, Borrowed), **Sharing & connections** (Shared links, Feed, Notifications, Recommended, Connections) and **Settings** (Import / export, Members, Account — Account moved here from the bottom; Log out stays there). Each section opens and closes from its header, with a click, a tap, or Enter and Space from the keyboard, and works without JavaScript. The section holding the page you're on is always open; the others start closed, and the ones you open stay open on that device, remembered in a small `nav` cookie so the page draws them open from the start. A closed section's header shows how many things in it are unread. Admin-only and connections-only links show to the same people as before.
- **Colour is never the only signal.** An overdue loan on an item's page says "overdue"; the current page in the sidebar and the chosen Scan / Search / Manual button are announced as such; links inside sentences are underlined.
- **Text contrast meets WCAG AA in both themes**: rating stars on light paper are a shade darker, error text a shade stronger, a hovered table row is a lighter tint, and the lamp-lit theme's small grey labels are a shade lighter.
- **Every field has a name** screen readers announce, and a refused form's message is read out and tied to the fields it's about. The Add page's barcode box — the way in without a camera — has a visible label.
- **Filter menus' checkboxes are spaced further apart**, so each is easier to tap, and a menu near the right edge of a phone's screen opens leftwards instead of hanging off it.
- **Keyboard focus is always visible and stays put.** Checkboxes and the Table / Covers and Scan / Search / Manual toggles show a clear focus ring, and recording a page, finishing a read or toggling Owned keeps your place instead of sending focus back to the top of the page.
- **Nothing scrolls a phone's page sideways**: long share links on a shelf's settings and a tag's page wrap, and the Members table keeps its buttons on screen.
- **A hovered table row** is a lighter tint with an indigo rule at its left edge, and a row picked for bulk edit likewise (a firmer rule), so the text on it stays readable.

### Fixed
- **Prices never reach share pages or connected households.** A libib import kept a file's `price` column in each item's details, which share pages and connected households were shown. Money in details is now left out of anything published; inside the app it stays where it was.
- **Discogs attribution, as its API terms require.** A record whose pressing came from Discogs now says **Data provided by Discogs.** right below its pressing details, linked to that release's page on discogs.com, with Discogs' notice under it: "This application uses Discogs’ API but is not affiliated with, sponsored or endorsed by Discogs. ‘Discogs’ is a trademark of Zink Media, LLC." It shows on the record's page, on a share page showing the record, on a connected household's record, and beside each Discogs result on the Add page. A record counts as coming from Discogs when its details hold a Discogs release id and something Discogs filled in, so records you typed in yourself show no credit. Share pages show nothing new besides the credit: the release id in its link is the Discogs ID they already list, and a record's grades stay private. The notice is also in the README and THIRD-PARTY.md. No migration and no new secret: nothing to do when upgrading.

### Upgrading
- **Back up first** (`npm run backup`). Two migrations run when you deploy, in order. Each was rehearsed on a copy of a real backup, and the two together on the latest one: every existing table came through identical, and neither changes your existing data:
  - `0038_recommendations` adds the `recommendations` table;
  - `0039_purchase-price` adds two empty columns to items (`purchase_price`, `purchase_currency`) and an empty `currency` to the household settings.
- **Rolling back** to 1.5.0 is safe: its code ignores the new table and columns.
- **Set the household currency** under **Members** before entering prices, and before importing a libib file whose prices you want as purchase prices. Until then no one can enter a price, and libib prices stay in the item's details (never on share pages now).
- **Board games added before this version have no weight** until you press **Refresh from BGG** on their page (one game per click, a few seconds apart); until then they appear under **Not enough details** when you filter by weight.
- **Backups** now also export `recommendations`, restored after `borrowed_items`. To restore a backup from before this version (a 1.5.0 backup is at migration 0037), restore it at its own migration level and apply 0038–0039 afterwards, as [runbooks/backup-and-restore.md](runbooks/backup-and-restore.md) says.
- **Exports** gain `purchase_price` and `purchase_currency`. Exports from before this version still import; an export from this version imports into an older one without purchase prices, which that version ignores. Recommendations, sent and received, are in **Borrowed → Export connections data**, not in `/export.csv`.
- **No new secrets.** **Refresh from BGG** uses the `BGG_TOKEN` that search already needs.
- **Connections:** the protocol is still version 1, and households on older versions keep working with yours. Your library's descriptor now also lists the message types it takes (`accepts`), which older versions ignore. **Households on 1.5.0 or older can't receive recommendations**: yours checks first and sends nothing to them, saying they run an older version; once they update, it works with nothing to do on either side. A game's weight travels among its details, as its player count does. Purchase prices are never sent to any connected household, on any version.
- **Contributors:** run `npm install`, then `npx playwright install chromium` once before `npm run a11y`.

## [1.5.0] - 2026-09-30

A lot for games, records and reading: a play and listening log, reading goals (shared with connected households if you like), want lists with shop links and gift-list shares, series with what's missing and what's next, a record's condition and pressing from Discogs, where each thing lives, and loans in the export.

### Added
- **Export and import now include loans.** A new `loans` column holds every loan of an item, still out or returned, with its borrower, the dates it went out, was due and came back, the contact and the note. Importing a Nalanda export brings them back onto the items it adds, whoever imports it; an export from before this version imports as it always did, without loans. A loan to a connected household comes back as an ordinary loan under the name it was lent to, since the link to that household can't be rebuilt from a file. Importing the same file twice still adds every item twice, each copy with its own loans, never a loan twice on one item. Very large exports now come in more, smaller pieces when items carry many loans; the Export button joins them into one file as before. Nothing to do when upgrading.
- **A play log for board games and a listening log for records.** A game's or record's page has a **Played** button: press it to log a play today, or pick another day in the date beside it. The page says how many times the household has played it and when last ("Played 12 times · last on 14 Sep"), lists the five most recent plays, and **All N plays** lists every one by year. A play is the household's, not a person's: no players, scores or durations, just the day. Whoever logged a play, or an admin, can remove it; admins see who logged each. Books have reads, not plays. A play changes nothing else about the item: its status, reads and ratings stay as they were.
- **Share pages say how many times** a shared game or record was played ("Played 3 times"), never when or by whom. Connected households see nothing of plays.
- **Export and import keep the play log.** A new `plays` column holds each play's date, oldest first, with who logged it. Importing the file back as an admin gives each play back to the member of the same name; a member's import makes them all theirs.
- **Where it lives.** Every item can have a **Location**, in your own words: "study, 2nd shelf", "Loft · box 3". Set it on the item form when you add or edit something; the item's page shows it. Search finds items by it, and so does a shelf's search box. It's private, like notes: share pages and connected households never see it. `/export.csv` has a new `location` column, and importing a Nalanda export brings it back. A libib-style file with a `location` column fills it too, instead of putting it in the item's details, which share pages show.
- **Series.** A book (or anything else) can belong to a series, with its number in it: "The Expanse", #3 — or #2.5 for a novella between two books, or no number at all. Set it on the edit form, which suggests the series you already have. Adding a book by scan or search fills it in when Open Library knows it (it does for many popular series, not all; Google Books never names a series). A name differing only in capitals or spacing is the same series.
- **What's missing, and what's next.** A book in a series shows the series as a row of numbers on its page: the volumes you have, the one you're looking at, and the whole numbers missing between them ("1, 2, 3, 5 → #4 is missing"). **Next up for you** is the lowest-numbered volume you haven't finished — your own reads, not the household's — and says so when a missing number comes before it.
- **Series pages.** **Series** in the sidebar lists every series with how many volumes you hold and how many are missing. A series' page lists its volumes in order with the missing numbers in their places, your next one, and what you've finished. There you can rename a series (a name another series already has merges the two) and set how many volumes it has; once that's set, the numbers after your last volume show as missing too.
- **Series leave and come back through the CSV.** The export gains `series`, `series_number` and `series_total`, and a Nalanda re-import restores them. A libib file's `group` — libib's word for a series — now also becomes the series (it stays a tag, as before). A Goodreads title's series suffix, "The Gunslinger (The Dark Tower, #1)", becomes the series of a book the import adds, and the title loses the suffix; books a Goodreads import merges into are left as they are.
- **A shared book's page shows its series name and number**, like its publisher. What's missing and anyone's next up stay inside the app, and connected households see nothing new.
- **A record's condition.** A record's edit form grades its media and its sleeve on the Goldmine scale Discogs uses: Mint (M), Near Mint (NM or M-), Very Good Plus (VG+), Very Good (VG), Good Plus (G+), Good (G), Fair (F) and Poor (P); a sleeve can also be Generic or No Cover. Anything else is refused. The grades show on the record's page and export as `media_condition` and `sleeve_condition`; an import reads them back by code or by Discogs' wording. They describe your copy, so like the number of copies they **never appear on share pages or to connected households**.
- **Pressing details from Discogs.** A record added from a Discogs result now keeps its labels, catalogue numbers, country, year, format (such as `2×Vinyl, LP, Album, 180 Gram, Red Translucent`) and tracklist, and a scanned record keeps its barcode. The record's page lists the pressing, with the tracklist folded under it. Share pages show the pressing and the tracklist; connected households see the pressing fields, not the tracklist.
- **Refresh from Discogs** on a record's page fills pressing details for records already in your catalog. It uses the record's Discogs release id, or else its barcode, and makes one Discogs request per click. It fills only what's blank and never changes a value that's there, including anything you typed yourself. A record found by barcode gets its tracklist on the next click.

- **Reading goals.** Each member can set a goal of N books for this year or next on the new **Reading goals** page (linked from the Overview); an admin can set anyone's. Every book you finish with an end date in that year counts, re-reads included; records, board games and undated finishes don't. The Overview shows your goal as "14 of 24" with a bar and your pace: on track, "3 behind", or reached. Pace is an even spread through the year. Goals stay out of `/export.csv`: they're about people, not items, and backups carry them.
- **Goals for connected households**, under a new switch, **Connections → Share reading goals**. With names shown to connections too, their feed gets an entry when a member sets a goal, passes halfway and reaches it ("Priya reached their 2026 goal"), with the target and the count. Only for members with a display name, recorded only as it happens, and never which books or when they were read. A line crossed by an imported or back-dated book is announced with the next book finished. The switch is greyed out while names are off. Your Feed shows connected households' goals the same way.

- **Want lists.** Each member has their own. **Want to read** on a book's page (**Want** on a record's or a game's) puts it on yours, and the same button on a scan or search result under **Add items** adds something not yet in your catalog as Not owned, straight onto your list. **Want list** in the sidebar shows yours, newest first, and anyone else's in the household. Finishing a book takes it off your list; stopping one, or someone else finishing it, doesn't.
- **Where to buy.** Any member can paste shop links onto an item — a label and a web address — or remove them. Only `https://` and `http://` addresses are taken.
- **Gift lists.** An admin can publish a member's want list as a share link, from their Want list page. It shows exactly what's on the list now — titles, covers and the Where to buy links — and nothing about reading, ratings, notes, loans or copies. It's titled "A want list", or with the member's display name when **Names on share pages** is on. Rotate and remove it like any share; **Shared links** lists it. Shelf share links don't show purchase links.
- **A "Wanted" badge** beside "Not owned", wherever that shows — shelves, search, tags, a book's page, share links and connected households' views — while someone in the household wants the item and you don't have a copy. It never says who.
- **"Want" on a record or a game** finds the copy already in your catalog — by barcode or Discogs release, or by BoardGameGeek id — as it does a book by ISBN, instead of adding a second one. A record scanned by its barcode now keeps that barcode.
- **Export and import carry them.** Two new columns: `wanted_by` (whose want list, and since when) and `purchase_links`. An admin's import gives each want back to the member of that name; a member's import makes every want theirs.

### Changed
- **New instances start with names and goals on.** On a new install, **Names on share pages**, **Show names to connected households** and **Share reading goals** are all on until an admin turns them off. Existing instances keep what they have (see Upgrading).
- **A share page no longer says a Not owned item was read.** It said "read, not on these shelves" even for a book nobody has read, such as a Goodreads to-read entry. It now says "in the catalogue, not on these shelves", or "wanted, not on these shelves yet" when someone wants it. A connected household's book page says the same.
- **The one-request export** (`/export.csv` without the Export button) reads everything beside each page of items in one database call, so it stays within the free plan's limits for far larger catalogs.

### Fixed
- **Development tools only:** undici, which the test runner pulls in, is pinned to 7.29.1 for six advisories (Dependabot). It isn't part of the app that runs on Cloudflare, so nothing changes for a running instance.
- **A loan's due date is kept only when it's a real date.** The item page's Lend form stored whatever it was sent, which the export couldn't carry; anything else now means no due date, as it already did when lending to a connected household. Due dates already stored as free text ("next week") still export and import unchanged.

### Upgrading
- **Back up first** (`npm run backup`). Eight migrations run when you deploy, in order. Each was rehearsed on a copy of a real backup, and none changes your existing data:
  - `0030_plays` adds the `plays` table;
  - `0031_location` adds an empty `location` column, and `0032_location-fts` rebuilds the search index to include it (it drops the index and its three triggers, makes them again, and refills it from your items — search finds what it found before);
  - `0033_series` adds a `series` table and two empty columns to items. There is no backfill: existing books stay out of any series until you edit them;
  - `0034_vinyl-condition` adds two empty columns for a record's grades;
  - `0035_reading-goals` adds the goals table and the **Share reading goals** switch, and `0036_goal-activity` rebuilds the per-person activity table so a goal entry can have no book, keeping every entry and its id;
  - `0037_want-to-read` adds the `wants` and `purchase_links` tables and one column to `shares`.
- **Your sharing settings don't change.** The new defaults (names and goals on) are for new instances only. If your instance already has members, 0036 writes down the settings you have been running on: names stay as an admin left them, and **Share reading goals** starts off. Nothing anyone outside sees changes until an admin switches something on.
- **Deploy when nobody is using the app, and don't roll back past this release** without restoring the backup: older code doesn't know the rebuilt activity table's goal entries.
- **Backups** now also export `plays`, `series`, `reading_goals`, `wants` and `purchase_links`. To restore a backup from before this version (a 1.4.0 backup is at migration 0029), restore it at its own migration level and apply 0030–0037 afterwards, as [runbooks/backup-and-restore.md](runbooks/backup-and-restore.md) says; migrated to the latest first, an instance restored from a backup that never saved a switch would start with names and goals on.
- **Exports** gain columns: `loans`, `plays`, `location`, `series`/`series_number`/`series_total`, `media_condition`/`sleeve_condition`, `wanted_by` and `purchase_links`. Exports from before this version still import. An export from this version imports into an older one without those columns, which that version ignores. **Reading goals aren't in `/export.csv`**, by design: a goal is a person's, not an item's; backups carry them.
- **Removing a member now clears their want list**, and any gift list published of it stops working. Their reads and reviews stay, as before.
- **No new secrets.** Pressing details and **Refresh from Discogs** use the `DISCOGS_TOKEN` you may already have; without it, a record's page says to set one.
- **Connections:** households on older versions keep working with yours; the protocol is still version 1. They skip goal entries without error and ignore the "Wanted" flag. Plays, loans, locations, series, a record's grades, want lists and purchase links are never sent to any connected household. A record's pressing fields travel in its details as its label and catalogue number always did; the tracklist isn't sent.

## [1.4.0] - 2026-09-30

What to read next, a book's lending history, bulk edit, and Nalanda on your phone's home screen with scanning that works offline. Also a security fix: a removed member's session could sign in as the next member created.

### Added
- **"Lent before" on an item's page**: every past loan of it, newest first, with who borrowed it, when it went out and came back, and for how many days. Loans to connected households are listed too, as "household (their member)". The latest 20 show, and older ones are counted. It appears only once something has been lent and returned, and only inside the app: share pages and connected households never see loans or borrowers. Nothing to do when upgrading — it reads the loans you already have.
- **Read next on the Overview.** A card suggests one book you haven't finished and aren't reading now, picked at random from any book in the catalog, owned or not ("Not owned" shows when you don't own it). What other members have read doesn't matter: it goes by your own reads. **Another** picks a different book in place, and **Start reading** starts your own read and takes you to the book's page. When you've finished or are reading every book, the card says so; a catalog without books doesn't show it.
- **Install Nalanda on your phone.** "Add to Home Screen" (iPhone and iPad: Safari's Share menu) or "Install app" (Android: Chrome's menu) puts Nalanda's tower on your home screen, and it opens full-screen like an app. There's a proper maskable icon for Android's shapes, and a long-press shortcut straight to scanning.
- **Scanning with no signal.** In a basement or a bookshop with no reception, the scanner keeps working: each barcode is held on your phone (the barcode and when you scanned it, nothing else). Back online, **Add items** lists what you scanned, each one looked up, for you to add to a shelf or drop, one at a time or all to one shelf. Nothing is added until you say so.
- **Pages are never kept on the phone.** The app keeps only its own files (the offline page and the scanner) for when there's no signal; your catalog, and every page a signed-in person sees, always come from your server. Logging out clears any scans still held, and someone else signing in on the same phone never sees them.
- **Bulk edit.** Tick items on a shelf, in the table or the covers view, or in search results, or use **Select all on this page**. A bar at the foot of the screen then offers **Add a tag**, **Remove a tag**, **Move to shelf**, **Mark owned** and **Mark not owned**, for books, board games and records alike. Up to 250 items at a time. Owned and not owned skip items held in 2 or more copies and say how many they skipped, as the Holding toggle does; change those counts on each item's edit form. Admins can also **Delete** in bulk, after a page that shows how many items and which. Members can't delete in bulk, though they can still delete one item from its page. Each action changes all the items or none of them, and it works without JavaScript.

### Fixed
- **Security: a removed member's session could sign in as the next member you created.** A new account can be given the id of the member removed just before it, and a session cookie named only that id, so a removed member's browser, still holding a cookie that lasts up to 30 days, was signed in as whoever was created next, admins included. Every account now has a random session key of its own, set when the account is made and never reused, and a cookie is accepted only for the account whose key it carries. A removed member's cookie now signs nobody in, even after their id is reused. The same goes for scans held offline on a shared phone: they belong to that account, not to its id.

### Upgrading
- **Back up first** (`npm run backup`). Migrations `0028_session-key` and `0029_session-key-backfill` run when you deploy. They add a session key to each account and fill in a random one for every account you have. Nothing else changes.
- **Everyone is signed out once.** Cookies from before this update carry no session key, so they no longer work, and everyone, you included, logs in again with their password. Passwords don't change. Anyone in the middle of a form when you deploy loses what they hadn't saved, so deploy when nobody is using the app.
- **Restoring a backup taken before this update** leaves its accounts without a key. Each account gets one the next time it logs in with its password, and nothing signs it in before that. [runbooks/backup-and-restore.md](runbooks/backup-and-restore.md) has the details.
- **Don't roll back past this release** without restoring the backup. Older code works with the new column, but it signs cookies without a key, and this version signs everyone out again when you come back to it.
- **No new secrets.**
- `wrangler.jsonc` now serves `.html` files under their own names (`"html_handling": "none"`), for the offline page. If you keep your own copy of `wrangler.jsonc`, add that line to its `assets` block.
- Phones that already added Nalanda to their home screen pick up the new icon when the browser next checks the manifest; removing and re-adding it is quicker.
- **Connections** are unaffected, including households on older versions: they never hold sessions here.

## [1.3.0] - 2026-09-29

Everyone's own reading. Each member of a household now has their own reads, recorded pages, rating and review, and a book's page shows everyone's under their name. A book still has one status on your shelves, and share links and connected households still see one household rating and review, with no names. Board games now carry BoardGameGeek's "Powered by BGG" logo, as its API terms require.

### Added
- **Your own reading.** **Read again**, **Finish**, **Stop** and **Record** act on your own reads. Another member can start their first read of a book you've finished, and two people can read a book at the same time. The edit form's status, dates, rating and review are yours.
- **Everyone's reading on the book's page**, each person's under their name, with their progress, and everyone's rating and review with their username. A household of one sees the page as before.
- **A "Read by" filter** on shelves and search: read by me, not read by me, read by a member or by anyone, and being read now. It can't be published: a share link made from a filtered shelf shows it without "Read by".
- **Admins can move** a read (with its recorded pages) or a review to another member, and change or delete anyone's. Members change only their own. The same works for records and board games, from their page.
- **Names on share pages and to connected households, when you choose.** Each member can set a **display name** on their Account page (an admin can set anyone's under Members). Two switches, both **off by default**, show names outside the app: on **Shared links**, a shared book lists each member's rating and review signed with their display name; on **Connections**, connected households get a feed entry per person ("Priya finished …", "Ravi rated …", "Priya started …") and see everyone's rating and review on a book's page. Members without a display name stay unnamed, login usernames never leave the app, and nobody outside ever sees the dates of anyone's reads. Names other households send show on your Feed and their book pages.
- **Export and import keep each person's history.** Each read in the `reads` column names its reader, and a new `reviews` column holds everyone's rating and review, with when each was written and given. When an admin imports the file, each read and review goes back to the member of the same name, or to the admin; a member's import is all theirs. The preview says who gets what.
- **The "Powered by BGG" logo**, linked to BoardGameGeek, now shows under board game search results, on a board game's page, and in the footer of a share page that shows a board game. BoardGameGeek's API terms require it wherever an app shows its data publicly. It uses BGG's own logo files, in its light and dark versions.

### Changed
- **A book's status is the household's:** Completed once anyone has finished it, In progress while anyone is reading it and nobody has finished, and "re-reading" while someone reads a book someone has finished. Its read count counts everyone's finishes, and its last finish is the latest by anyone.
- **Its rating is the household's average** (rounded to the half-star), and its review is the one written last. That is what shelves, share pages and connections show.
- **Goodreads and libib imports are the importer's own.** A Goodreads re-import is matched against your reads and your review only, and never touches anyone else's.
- **Removing a member** keeps their reads and reviews, shown as a former member's. Nothing about a book changes.
- **Comments and borrow requests you send no longer carry your login username.** They're signed with your display name while names are switched on for connections, and "A member" otherwise.
- **Taking back a rating or review isn't news.** When a member's newer review or rating goes and an older one shows again, connected households see it dated when it was first given, not as today's.
- **A backup that stops partway** now says its folder is incomplete, and to delete it before running the backup again. Otherwise the retry lands beside it as `-2`, and the incomplete folder keeps today's name. The backup runbook says the same.

### Fixed
- **A board game search that BoardGameGeek throttles** now says BGG is busy and to try again in a few seconds. It used to say no board games were found. Other failures now say BGG did not answer.
- **`npm run backfill:remote` paces BoardGameGeek** at one request every 5 seconds, as BGG's docs ask. It used to send up to 4 a second.
- **Board game descriptions from BoardGameGeek are kept whole**, paragraphs included, and quotes and dashes show as themselves instead of codes like `&#039;` or `&mdash;`. They used to be cut at 2,000 characters, which BGG's terms don't allow, and their blank lines were lost. Games added before this keep the text they have until you edit it or fill it in again.
- **Setting up before `SESSION_SECRET` is set** no longer locks you out. Setup used to create your admin account and then fail with an error, which closed setup, and login then failed the same way. Now setup and login say the secret is missing and how to set it, and nothing is saved until it is.
- **A `SESSION_SECRET` that is only spaces or blank lines** now counts as missing. It used to be accepted, and it signed session cookies that anyone could forge. If yours is blank, sign-in stops after this update until you set a real one: `npx wrangler secret put SESSION_SECRET`.
- **Two setups at once**, such as a double-click on **Create account**, now make one admin and one set of starter shelves. A double-click could end in an error, and two people racing made two admins. The setup that loses lands on the login page, which says another setup finished first; after a double-click, the password you just chose works there.

### Upgrading
- **Back up first** (`npm run backup`). Migrations `0024_per-member`, `0025_per-member-backfill`, `0026_member-names` and `0027_member-activity-triggers` run when you deploy.
- **All your existing history goes to your first admin.** Nothing before 1.3.0 recorded who read or rated what, so every existing read, every recorded page, and each book's rating and review are credited to the admin with the lowest id (normally the account made at `/setup`). No book changes on your shelves, share pages or connections. In a household of one there's nothing more to do. Otherwise, an admin moves each misattributed read or review to the right member from the book's page: **Edit** on it, choose the member, **Move**. [runbooks/updating.md](runbooks/updating.md) walks through it. Move rather than have members re-import Goodreads, which would add their reads beside the admin's copies.
- **What share pages show now:**
  - the household's average rating;
  - the review written most recently, with no author;
  - "Read N times" counting everyone's finishes;
  - with progress switched on, the latest page anyone reading the book recorded.

  Nothing per person appears until an admin switches names on. With one member, all of this is exactly what they showed before.
- **Names stay private until an admin turns them on.** 0026 and 0027 add display names, the two switches (both off) and a per-person activity log. If you share anything with connections, it starts with the last 90 days of ratings, reviews and recorded pages; starts and finishes join it only as they happen from now on, so nobody's read dates go out. Until an admin switches names on, share pages, your feed and your books' pages look to everyone outside exactly as before. Switching names on for connections swaps the unnamed entries they hold for named ones at their next check, and switching off swaps them back; a household can still keep what it already pulled. Renaming or removing a member, or moving a read or review to another member, updates the entries they already have the same way.
- **Deploy when nobody is editing, and don't roll back past this release.** In the seconds between the migration and the new code, an edit saved by the old code makes a read that belongs to nobody, or a rating with no review behind it, which the average replaces at the book's next review. Older code writes reading and ratings without a person, so to go back, restore the backup instead. A 1.3.0 export doesn't import correctly into an older version.
- **No new secrets.**
- **Board game search needs BoardGameGeek's approval.** If you have no `BGG_TOKEN` yet, apply for a non-commercial application at boardgamegeek.com/applications; once BGG approves it, create a token there and run `npx wrangler secret put BGG_TOKEN`. [runbooks/deploy.md](runbooks/deploy.md) → API tokens has the steps. If you already have one, nothing to do.
- **If your `SESSION_SECRET` is blank** (only spaces or blank lines), everyone is signed out after this update and nobody can sign in until you set a real one: `npx wrangler secret put SESSION_SECRET`, with a value from `openssl rand -base64 32`. Setup and login say so.
- **If setup once failed with an error** and you couldn't log in afterwards, your admin account was created before the error. Set `SESSION_SECRET`, then log in with the username and password you chose at setup.
- **Connections:** households on older versions keep working with yours. The protocol is still version 1: they see the household's rating, review and read count as before. With names switched on, they get your entries without the names, as the household's (two people finishing one book show as one entry), skip "started", and don't see the list of everyone's reviews. Comments and borrow requests from your members reach them signed "A member", or with the display name when names are on.

## [1.2.1] - 2026-09-28

Small fixes found while releasing 1.2.0.

### Fixed
- **A missing script, stylesheet or icon** gets a plain "Not found" even when you're signed out. It used to redirect to the login page, which a browser can't run as a script. It only matters if a file ever goes missing.
- **A same-day backup no longer overwrites an earlier one.** `npm run backup` writes to `backups/remote-<date>-2`, `-3` and so on when today's folder exists, so the backup taken before a deploy survives one taken after it.

### Changed
- **Backup runbook:** it now says a page opened during a backup can fail for those few seconds, so back up when nobody is using Nalanda.
- **Records and board games being played again:** the edit form's check against opening a second read is now documented and covered by a test. A review had taken it for dead code.

### Upgrading
- **No database migrations and no new secrets.** Deploy as usual.
- **Connections** are unaffected.

## [1.2.0] - 2026-09-28

Re-reading. Every read of a book is kept, so reading it again no longer overwrites the first read, and Nalanda knows how many times you've read it.

### Added
- **Read again.** A finished book has a **Read again** button that starts a new read, and the book shows a **Re-reading** marker until you finish it. It stays **Completed** meanwhile, so nothing moves between shelves, filters or shared views.
- **Your reads on the book's page:** each read with its dates, and the pages you recorded during it. You can finish a read, stop it, correct its dates, add a past read, or delete one made by mistake.
- **How often you've read a book:**
  - shown as "×2" beside its finished date on a shelf;
  - as "Read 2 times" on share pages (only for books read twice or more; never the dates);
  - to connected households on 1.2.0, who see "re-reading" and "finished again".
- **Export and import carry every read**, including which read each recorded page belongs to. Older exports still import.
- **Goodreads' Read Count** becomes that many finished reads, and a Goodreads re-import adds reads without ever removing one.

### Changed
- **The edit form's status and dates** now edit the current read. It won't turn a finished book back to "In progress" or "Stopped": use **Read again** on its page. While a book is being re-read, those fields are locked.
- **A Goodreads re-import that changes nothing** now leaves every book's "updated" time alone.
- **The import preview** counts the reads a libib file will create.

### Upgrading
- **Back up first** (`npm run backup`). Migrations `0022_reads` and `0023_reads-backfill` turn every book's status and dates into reads when you deploy. Most books come out exactly as they were. A few shapes change, by the same rules imports use:
  - a not-started book with a start date becomes **In progress**, and one with a completion date becomes **Completed**;
  - a stopped book with a Goodreads Read Count becomes **Completed**, with that many finished reads beside the stopped one;
  - a Read Count becomes finished reads (at most 100) and leaves the book's details. A count that isn't a whole number stays in details.

  [runbooks/deploy.md](runbooks/deploy.md) lists these under "What 0023 does to your data".
- **Deploy when nobody is editing.** For a few seconds the migration has run while the old code still serves, and an edit saved in that window doesn't become a read.
- **Don't roll the code back past this release.** Older code writes reading status without reads. It won't crash, but reading state drifts until each book's next change. To go back, restore the backup instead.
- **No new secrets.**
- **Connections:** households on 1.1.0 or earlier keep working with yours. They simply don't see read counts or the "re-reading" label.

## [1.1.0] - 2026-09-28

A polish pass over every page, in light and dark mode, on desktop and phone, and the first release with version numbers and notes. Nothing changes how Nalanda works; things just look right where they used to slip.

### Fixed
- **Dark mode:** checkboxes, date pickers and the file picker follow the dark theme instead of showing in light.
- **Phones:**
  - adding a book no longer scrolls sideways;
  - table row buttons stack instead of being cut off;
  - the menu button lines up with the page;
  - share pages and the login card use the same margins as the rest of the app.
- **Cover grids:** accession numbers and type labels no longer get crushed, and catalogue data (ISBNs, lengths) stays in the monospace data face.
- **Buttons:** secondary buttons had been showing as primary. Each form's own action is now the only primary one, and Purge uses the danger style.
- **Small grey text** is easier to read: the faintest ink meets 4.5:1 contrast in both themes.
- **Spacing:**
  - the feed, notifications, connections, overview and search pages are spaced consistently;
  - unread notifications no longer wrap under their dot;
  - an empty shelf says it's empty instead of blaming filters that aren't set.

### Added
- **A styled "Not found" page.** For a share link that has changed or been removed, it uses the share page's own look and reveals nothing about what is or was shared. Every such case costs the same work, so timing gives nothing away either.
- **Broken covers** show the media-type placeholder, the same as a book with no cover, when a cover image fails to load.
- **The phone menu** tells screen readers whether it's open, closes on Escape, and can't be tabbed into while closed.
- **Version numbers and release notes.** The **Account** page shows the version you're running, linked to its notes. This changelog gives every release an Upgrading section, each tag is published as a [GitHub Release](https://github.com/isstiaung/nalanda/releases), and [runbooks/updating.md](runbooks/updating.md) walks through an update.

### Upgrading
- **No database migrations and no new secrets.** Deploy as usual.
- **Connections** are unaffected: the protocol hasn't changed, so households on 1.0.0 and 1.1.0 work together.

## [1.0.0] - 2026-09-28

The first versioned release: Nalanda as it stood when versioning began.

A self-hosted library manager for a household:
- catalogue books, board games and vinyl records by barcode scan or name search, with covers and details filled in from Open Library, Google Books, BoardGameGeek and Discogs;
- tags, loans and reading progress;
- public read-only share links for a whole shelf, a filtered view or a tag;
- CSV import from libib and Goodreads, and a full CSV export that imports back;
- members, each with their own login;
- connections between households: follow each other's reading, comment on reviews, and borrow books, with in-app notifications.

It runs on Cloudflare's free plan (Workers, D1, R2).

### Upgrading
From an instance deployed before versioning:
- **Back up first** (`npm run backup`). This release applies migrations up to `0021_activity-dating` when you deploy. They add reading progress, notifications and site settings, and re-date connection activity by when it happened.
- **BoardGameGeek now needs a token.** BGG made its API registration-only in 2025. Register an application at boardgamegeek.com/applications, then run `npx wrangler secret put BGG_TOKEN`. Without it, board-game search shows a notice instead of results.
- **Export needs JavaScript for a large catalogue.** The **Export** button fetches the CSV a page at a time. The plain `/export.csv` link still works, in one request, but can hit the free plan's CPU limit on a large catalogue.

[1.3.0]: https://github.com/isstiaung/nalanda/releases/tag/v1.3.0
[1.2.1]: https://github.com/isstiaung/nalanda/releases/tag/v1.2.1
[1.2.0]: https://github.com/isstiaung/nalanda/releases/tag/v1.2.0
[1.1.0]: https://github.com/isstiaung/nalanda/releases/tag/v1.1.0
[1.0.0]: https://github.com/isstiaung/nalanda/releases/tag/v1.0.0
