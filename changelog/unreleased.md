## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Added
- **Two contributor guides.** [docs/adding-a-column.md](../docs/adding-a-column.md) and [docs/adding-a-provider.md](../docs/adding-a-provider.md) walk the two most common changes in order — the existing rules, sequenced — linked from CONTRIBUTING.md. Nothing in the app changes.
- **Borrowed from someone.** A book borrowed from a friend is in the catalog as Not owned, with a borrow record: on its page, under Circulation, **Borrowed from**, a contact, a due date and a note, and **Mark returned** when it goes back. A **Borrowed** pill shows beside Not owned on the item, on shelves and in search; the shelf's Holding filter gains **Borrowed from someone**. **Borrowed**, under Lending, is now for every household — what is borrowed from people, overdue flagged, and what was returned — with the connections sections following where connections are enabled. Private like loans: never on a share link, never to connections. Round-trips through the CSV as a `borrowed` cell, shaped like `loans`.

### Upgrading
- **One migration, 0048: a new `borrows` table, no data changed.** [Back up](../runbooks/backup-and-restore.md) first as before any migration, then deploy as usual. The backup's table order gains `borrows`.
