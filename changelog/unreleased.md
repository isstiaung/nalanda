## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Fixed
- **The demo's share links, QR codes and feeds point at the demo.** The app writes a share's address in full, from the address a page was loaded at, so in the published demo they read `http://127.0.0.1:8818/…` — the scratch server the demo is built from — and the share pages themselves were never crawled. The build now takes the site's origin from Pages and points every such address at the demo's own copy, share pages and feeds included. [runbooks/demo.md](../runbooks/demo.md) also says how to let release tags publish it.

### Added
- **Members join with a link, not a password.** **Create account** under Members now shows a one-time invite link, with its QR code to scan from your screen. The new member opens it, chooses their own password and is signed in; you never see it. **Reset password** works the same way: the old password and every session end at once, and a reset link lets them choose another. A link works once, for seven days, and only its hash is kept; Members shows *Invited* or *Reset link out* until it's used ([runbooks/accounts-and-access.md](../runbooks/accounts-and-access.md), ARCH.md §16 #97).

### Upgrading
- **One migration, 0059: a new `account_links` table, no data changed.** [Back up](../runbooks/backup-and-restore.md) first as before any migration, then deploy as usual. Backups leave the table out on purpose, as they leave `login_attempts` out: links are short-lived secrets. A member who still has a temporary password from before keeps it and changes it at first sign-in, as before.
