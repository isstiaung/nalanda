## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Changed
- The reading goal's note under the bar now reads "The mark shows where you'd be reading evenly since 1 January."

### Fixed
- Date fields sat a pixel above the button beside them in Chrome at about half of row positions; they now sit level. Safari is unchanged.
- **Scans held offline can go straight onto your want list** from the Add page's review list (**Want to read** / **Want**), as search results can. A held scan of a book already in the catalog is wanted on that copy.
- The accessibility audit now presses the Add page's **More results**, and `npm run a11y -- --only=<word>` also picks out single htmx steps.
