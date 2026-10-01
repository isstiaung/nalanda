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
- **Custom fields.** Under **Members**, an admin defines up to ten fields of the household's own — a line of text, a yes/no or a date: *Gifted by*, *Signed*, *Bought on* — and every item's form shows them, its page listing what is set under **Fields**. Private by default: a field's values appear on a shared item's page only while its own **Show on share pages** switch is on, and never go to connected households. Renaming keeps the values; deleting a field deletes every item's value for it (the confirm says so), and History records each change. They round-trip through the export in a `custom` column by the field's name, so a file moves between households — an import keeps what lands on a field of the same name here and says how many values had none ([ARCH.md §16 #95](../docs/decisions/095-custom-fields.md); [runbook](../runbooks/accounts-and-access.md#custom-fields)).

### Upgrading
- **Two migrations, 0055 and 0056: a new `custom_fields` table and a `custom` column on `items` (empty until a field is set), and the item-history trigger recreated with that column — no data changed.** [Back up](../runbooks/backup-and-restore.md) first as before any migration, then deploy as usual. The backup's table order gains `custom_fields`, before `items`. Connections on older versions are unaffected: nothing new is sent to them.
