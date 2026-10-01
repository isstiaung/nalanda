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

### Added
- **The interface in your language — हिन्दी and தமிழ் to start.** Every string on the sidebar, log in and setup, the Overview, a shelf's page and its filter bar, an item page's labels, pills and buttons, the Add page, Account, Members, Import/export's headings and buttons, the Trash, and the share pages' own few strings now comes from one table, English the source, with full Hindi and Tamil translations shipped — machine-drafted, and marked so until a native reader checks them. The interface follows the household language set under Members (where a translation exists; a household in French stays in English for now), and each member can pick another under **Account → Language**; share pages always show the household's. Item data, names and anything you typed are never translated. To correct a draft or add a language: download the strings from Account (`/strings/hi.json`, `/strings/ta.json`), edit the file, and either have an admin import it under **Members → Interface translations** — this household's own words, key by key, share pages included — or open a pull request to ship it to everyone. The rest of the app stays English for now and is translated page by page in later releases.

### Upgrading
- **One migration, 0057: a `locale` column on `users` (empty: everyone follows the household) and a new `translations` table (empty until an admin imports one), no data changed.** [Back up](../runbooks/backup-and-restore.md) first as before any migration, then deploy as usual; nothing else to do. The backup's table order gains `translations`. Pages stay English until the household language under Members is Hindi or Tamil, or a member picks one on Account.
