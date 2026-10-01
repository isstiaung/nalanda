## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Added
- **A static demo.** `npm run demo:build` seeds a scratch instance and crawls it into plain HTML — every page a member sees, links intact, every form answered with "read-only demo", a few canned searches, no service worker, a banner — behind a sign-in that accepts `demo` / `demo` in the browser and says it isn't security. A workflow publishes it to GitHub Pages on each release ([runbooks/demo.md](../runbooks/demo.md)). Nothing in the app changes.

### Changed
- **The README is short; the features live in [docs/features/](../docs/features/README.md).** The wall of feature bullets is gone from the README, which now keeps the intro, the screenshots, local development, running your own, and the runbook index, and points at one page per area — cataloguing, reading, shelves and search, imports and exports, sharing, lending, connections, members and privacy, on your phone — each written against the code as it is, with the runbooks and decisions it rests on linked. Nothing in the app changes.

### Fixed
- **The Import / export page's subtitle names every format it takes** — libib, Goodreads, StoryGraph and LibraryThing — where it named two. Wording only.
