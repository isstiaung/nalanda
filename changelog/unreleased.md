## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Added
- **Feeds for share links.** Every share link has an Atom and an RSS feed — `/share/<token>/feed.atom` and `.rss`, linked from the page's head so a reader finds them — of its twenty newest additions (a gift list's newest wants), each with the title, creators, cover, the household's rating and latest review, and a link to the item's share page. The same whitelist as the page; dated by when the item was added, never by anyone's reading. Cached with the page, gone with the token.
