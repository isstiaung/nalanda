# Changelog

Every release of Nalanda, newest first. Versions follow [Semantic Versioning](https://semver.org/):

- a **patch** release (1.1.x) fixes bugs;
- a **minor** release (1.x.0) adds features, and may carry database migrations that apply on their own when you deploy;
- a **major** release (x.0.0) needs something from you beyond deploying, or breaks compatibility with connected households on older versions.

Each release has an **Upgrading** section. Read it for every version between yours and the one you're moving to. [runbooks/updating.md](runbooks/updating.md) walks through an update. Your running version is on the **Account** page.

## [Unreleased]

### Changed
- **A backup that stops partway** now says its folder is incomplete, and to delete it before running the backup again. Otherwise the retry lands beside it as `-2`, and the incomplete folder keeps today's name. The backup runbook says the same.

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

[1.2.1]: https://github.com/isstiaung/nalanda/releases/tag/v1.2.1
[1.2.0]: https://github.com/isstiaung/nalanda/releases/tag/v1.2.0
[1.1.0]: https://github.com/isstiaung/nalanda/releases/tag/v1.1.0
[1.0.0]: https://github.com/isstiaung/nalanda/releases/tag/v1.0.0
