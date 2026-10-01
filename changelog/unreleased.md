## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Added
- **A static demo.** `npm run demo:build` seeds a scratch instance and crawls it into plain HTML — every page a member sees, links intact, every form answered with "read-only demo", a few canned searches, no service worker, a banner — behind a sign-in that accepts `demo` / `demo` in the browser and says it isn't security. A workflow publishes it to GitHub Pages on each release ([runbooks/demo.md](../runbooks/demo.md)). Nothing in the app changes.

### Changed
- **The README is short; the features live in [docs/features/](../docs/features/README.md).** The wall of feature bullets is gone from the README, which now keeps the intro, the screenshots, local development, running your own, and the runbook index, and points at one page per area — cataloguing, reading, shelves and search, imports and exports, sharing, lending, connections, members and privacy, on your phone — each written against the code as it is, with the runbooks and decisions it rests on linked. Nothing in the app changes.

### Fixed
- **The Import / export page's subtitle names every format it takes** — libib, Goodreads, StoryGraph and LibraryThing — where it named two. Wording only.

### Added
- **Scan a whole shelf in one go.** Tick **Keep scanning** beside the camera on Add items and each barcode is held on the phone with a beep and a running count, the camera staying on for the next — the same list that holds barcodes scanned with no signal, so online and offline are now one. **Add all to <shelf>** then looks the held barcodes up twenty at a time and adds what it finds as bare records — title, creators, publisher, ISBNs, pages, the series — leaving alone anything the catalog already has (by ISBN-13, ISBN-10 or a record's barcode — a book you hold with only its ISBN-10 is found by its barcode too), holding rather than adding a book that may already be here under no number at all (matched by title and author, named for you to look up and decide), and reporting "N added, M already here, P maybe already here, K not found" with each title. A barcode nothing is found for stays on the list with **Add by hand**, which opens the manual form with it filled in. New items arrive without covers; the cover backfill on the Import page fills them in at its own pace. **Look up** on any one held barcode still shows it alone, to pick its shelf, want it or drop it ([ARCH.md §16 #94](../docs/decisions/094-rapid-batch-scanning.md)).
