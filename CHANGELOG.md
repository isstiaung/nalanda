# Changelog

Every release of Nalanda, newest first. Versions follow [Semantic Versioning](https://semver.org/):

- a **patch** release (1.1.x) fixes bugs;
- a **minor** release (1.x.0) adds features, and may carry database migrations that apply on their own when you deploy;
- a **major** release (x.0.0) needs something from you beyond deploying, or breaks compatibility with connected households on older versions.

Each release has an **Upgrading** section. Read it for every version between yours and the one you're moving to. [runbooks/updating.md](runbooks/updating.md) walks through an update. Your running version is on the **Account** page.

## [Unreleased]

### Added
- **Export and import now include loans.** A new `loans` column holds every loan of an item, still out or returned, with its borrower, the dates it went out, was due and came back, the contact and the note. Importing a Nalanda export brings them back onto the items it adds, whoever imports it; an export from before this version imports as it always did, without loans. A loan to a connected household comes back as an ordinary loan under the name it was lent to, since the link to that household can't be rebuilt from a file. Importing the same file twice still adds every item twice, each copy with its own loans, never a loan twice on one item. Very large exports now come in more, smaller pieces when items carry many loans; the Export button joins them into one file as before. Nothing to do when upgrading.

### Fixed
- **A loan's due date is kept only when it's a real date.** The item page's Lend form stored whatever it was sent, which the export couldn't carry; anything else now means no due date, as it already did when lending to a connected household. Due dates already stored as free text ("next week") still export and import unchanged.

### Upgrading
- No migrations and no new secrets. Deploy as usual.
- An export made by this version has a `loans` column. An older Nalanda ignores it when importing the file, so the loans don't come back there.

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
