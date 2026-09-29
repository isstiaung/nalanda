# Changelog

Every release of Nalanda, newest first. Versions follow [Semantic Versioning](https://semver.org/):

- a **patch** release (1.1.x) fixes bugs;
- a **minor** release (1.x.0) adds features, and may carry database migrations that apply on their own when you deploy;
- a **major** release (x.0.0) needs something from you beyond deploying, or breaks compatibility with connected households on older versions.

Each release has an **Upgrading** section. Read it for every version between yours and the one you're moving to. [runbooks/updating.md](runbooks/updating.md) walks through an update. Your running version is on the **Account** page.

## [1.3.0] - 2026-09-29

Everyone's own reading. Each member of a household now has their own reads, recorded pages, rating and review, and a book's page shows everyone's under their name. A book still has one status on your shelves, and share links and connected households still see one household rating and review, with no names. Board games now carry BoardGameGeek's "Powered by BGG" logo, as its API terms require.

### Added
- **Your own reading.** **Read again**, **Finish**, **Stop** and **Record** act on your own reads. Another member can start their first read of a book you've finished, and two people can read a book at the same time. The edit form's status, dates, rating and review are yours.
- **Everyone's reading on the book's page**, each person's under their name, with their progress, and everyone's rating and review with their username. A household of one sees the page as before.
- **A "Read by" filter** on shelves and search: read by me, not read by me, read by a member or by anyone, and being read now. It can't be published: a share link made from a filtered shelf shows it without "Read by".
- **Admins can move** a read (with its recorded pages) or a review to another member, and change or delete anyone's. Members change only their own. The same works for records and board games, from their page.
- **Export and import keep each person's history.** Each read in the `reads` column names its reader, and a new `reviews` column holds everyone's rating and review, with when each was written and given. When an admin imports the file, each read and review goes back to the member of the same name, or to the admin; a member's import is all theirs. The preview says who gets what.
- **The "Powered by BGG" logo**, linked to BoardGameGeek, now shows under board game search results, on a board game's page, and in the footer of a share page that shows a board game. BoardGameGeek's API terms require it wherever an app shows its data publicly. It uses BGG's own logo files, in its light and dark versions.

### Changed
- **A book's status is the household's:** Completed once anyone has finished it, In progress while anyone is reading it and nobody has finished, and "re-reading" while someone reads a book someone has finished. Its read count counts everyone's finishes, and its last finish is the latest by anyone.
- **Its rating is the household's average** (rounded to the half-star), and its review is the one written last. That is what shelves, share pages and connections show.
- **Goodreads and libib imports are the importer's own.** A Goodreads re-import is matched against your reads and your review only, and never touches anyone else's.
- **Removing a member** keeps their reads and reviews, shown as a former member's. Nothing about a book changes.
- **Taking back a rating or review isn't news.** When a member's newer review or rating goes and an older one shows again, connected households see it dated when it was first given, not as today's.
- **A backup that stops partway** now says its folder is incomplete, and to delete it before running the backup again. Otherwise the retry lands beside it as `-2`, and the incomplete folder keeps today's name. The backup runbook says the same.

### Fixed
- **A board game search that BoardGameGeek throttles** now says BGG is busy and to try again in a few seconds. It used to say no board games were found. Other failures now say BGG did not answer.
- **`npm run backfill:remote` paces BoardGameGeek** at one request every 5 seconds, as BGG's docs ask. It used to send up to 4 a second.
- **Setting up before `SESSION_SECRET` is set** no longer locks you out. Setup used to create your admin account and then fail with an error, which closed setup, and login then failed the same way. Now setup and login say the secret is missing and how to set it, and nothing is saved until it is.
- **A `SESSION_SECRET` that is only spaces or blank lines** now counts as missing. It used to be accepted, and it signed session cookies that anyone could forge. If yours is blank, sign-in stops after this update until you set a real one: `npx wrangler secret put SESSION_SECRET`.
- **Two setups at once**, such as a double-click on **Create account**, now make one admin and one set of starter shelves. A double-click could end in an error, and two people racing made two admins. The setup that loses lands on the login page, which says another setup finished first; after a double-click, the password you just chose works there.

### Upgrading
- **Back up first** (`npm run backup`). Migrations `0024_per-member` and `0025_per-member-backfill` run when you deploy.
- **All your existing history goes to your first admin.** Nothing before 1.3.0 recorded who read or rated what, so every existing read, every recorded page, and each book's rating and review are credited to the admin with the lowest id (normally the account made at `/setup`). No book changes on your shelves, share pages or connections. In a household of one there's nothing more to do. Otherwise, an admin moves each misattributed read or review to the right member from the book's page: **Edit** on it, choose the member, **Move**. [runbooks/updating.md](runbooks/updating.md) walks through it. Move rather than have members re-import Goodreads, which would add their reads beside the admin's copies.
- **What share pages show now:**
  - the household's average rating;
  - the review written most recently, with no author;
  - "Read N times" counting everyone's finishes;
  - with progress switched on, the latest page anyone reading the book recorded.

  Nothing per person ever appears. With one member, all of this is exactly what they showed before.
- **Deploy when nobody is editing, and don't roll back past this release.** In the seconds between the migration and the new code, an edit saved by the old code makes a read that belongs to nobody, or a rating with no review behind it, which the average replaces at the book's next review. Older code writes reading and ratings without a person, so to go back, restore the backup instead. A 1.3.0 export doesn't import correctly into an older version.
- **No new secrets.**
- **Board game search needs BoardGameGeek's approval.** If you have no `BGG_TOKEN` yet, apply for a non-commercial application at boardgamegeek.com/applications; once BGG approves it, create a token there and run `npx wrangler secret put BGG_TOKEN`. [runbooks/deploy.md](runbooks/deploy.md) → API tokens has the steps. If you already have one, nothing to do.
- **If your `SESSION_SECRET` is blank** (only spaces or blank lines), everyone is signed out after this update and nobody can sign in until you set a real one: `npx wrangler secret put SESSION_SECRET`, with a value from `openssl rand -base64 32`. Setup and login say so.
- **If setup once failed with an error** and you couldn't log in afterwards, your admin account was created before the error. Set `SESSION_SECRET`, then log in with the username and password you chose at setup.
- **Connections:** households on older versions keep working with yours. The protocol hasn't changed; they see the household's rating, review and read count as before, and never a member's name.

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
