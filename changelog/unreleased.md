## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Changed
- The reading goal's note under the bar now reads "The mark shows where you'd be reading evenly since 1 January."
- **Pages read far less of the database.** The Overview reads about a fifth of the rows it did, a shelf about a sixth, a tag's page about a third and a tag's share link a quarter, and Year in review about half — with fewer database calls, and nothing on any page changes. On a 2,000-item catalogue a day's ordinary use comes to about 3% of the free plan's daily rows, down from 12%. The analysis is in [docs/perf/query-analysis.md](../docs/perf/query-analysis.md).

### Fixed
- Date fields sat a pixel above the button beside them in Chrome at about half of row positions; they now sit level. Safari is unchanged.
- **Scans held offline can go straight onto your want list** from the Add page's review list (**Want to read** / **Want**), as search results can. A held scan of a book already in the catalog is wanted on that copy.
- The accessibility audit now presses the Add page's **More results**, and `npm run a11y -- --only=<word>` also picks out single htmx steps.

### Upgrading
- **One migration, 0040: indexes only.** It adds seven indexes and changes no data. [Back up](../runbooks/backup-and-restore.md) first as before any migration, then deploy as usual — the deploy applies it. On a 2,000-item catalogue building them writes about 10,000 rows once, of the free plan's 100,000 a day; afterwards adding an item writes about four more rows than before.
- **Connections** are unaffected: nothing sent to or received from another household changes.
