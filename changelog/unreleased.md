## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Fixed
- **The demo's share links, QR codes and feeds point at the demo.** The app writes a share's address in full, from the address a page was loaded at, so in the published demo they read `http://127.0.0.1:8818/…` — the scratch server the demo is built from — and the share pages themselves were never crawled. The build now takes the site's origin from Pages and points every such address at the demo's own copy, share pages and feeds included. [runbooks/demo.md](../runbooks/demo.md) also says how to let release tags publish it.
