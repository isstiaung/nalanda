## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Added
- **A static demo.** `npm run demo:build` seeds a scratch instance and crawls it into plain HTML — every page a member sees, links intact, every form answered with "read-only demo", a few canned searches, no service worker, a banner — behind a sign-in that accepts `demo` / `demo` in the browser and says it isn't security. A workflow publishes it to GitHub Pages on each release ([runbooks/demo.md](../runbooks/demo.md)). Nothing in the app changes.
- **Borrowed from someone.** A book borrowed from a friend is in the catalog as Not owned, with a borrow record: on its page, under Circulation, **Borrowed from**, a contact, a due date and a note, and **Mark returned** when it goes back. A **Borrowed** pill shows beside Not owned on the item, on shelves and in search; the shelf's Holding filter gains **Borrowed from someone**. **Borrowed**, under Lending, is now for every household — what is borrowed from people, overdue flagged, and what was returned — with the connections sections following where connections are enabled. Private like loans: never on a share link, never to connections. Round-trips through the CSV as a `borrowed` cell, shaped like `loans`.
- **Author A–Z.** A shelf's sort gains the author's surname — the first creator's last name, or the name before the comma when a creator is written "Le Guin, Ursula K." — then their full name, then the title; items with nobody named come last. A share link can be published in that order too.

### Upgrading
- **One migration, 0048: a new `borrows` table, no data changed.** [Back up](../runbooks/backup-and-restore.md) first as before any migration, then deploy as usual. The backup's table order gains `borrows`.
