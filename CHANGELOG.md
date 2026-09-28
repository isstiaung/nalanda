# Changelog

Every release of Nalanda, newest first. Versions follow [Semantic Versioning](https://semver.org/):

- a **patch** release (1.1.x) fixes bugs;
- a **minor** release (1.x.0) adds features, and may carry database migrations that apply on their own when you deploy;
- a **major** release (x.0.0) needs something from you beyond deploying, or breaks compatibility with connected households on older versions.

Each release has an **Upgrading** section. Read it for every version between yours and the one you're moving to. [runbooks/updating.md](runbooks/updating.md) walks through an update. Your running version is on the **Account** page.

## [1.1.0] - 2026-09-28

A polish pass over every page, in light and dark mode, on desktop and phone. Nothing changes how Nalanda works; things just look right where they used to slip.

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

[1.1.0]: https://github.com/isstiaung/nalanda/releases/tag/v1.1.0
[1.0.0]: https://github.com/isstiaung/nalanda/releases/tag/v1.0.0
