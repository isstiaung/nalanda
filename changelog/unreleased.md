## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Fixed

- **sharp 0.35.5** (GHSA-wq5f-xc86-pv6w, librsvg). A development dependency only: miniflare uses it to
  emulate the Images binding, which Nalanda doesn't use, so no deployed instance ever ran it on an image.
  The `overrides` pin in `package.json` moves from 0.35.4 to 0.35.5 (ARCH.md §16 #30).
- **Vitest 4.1.12** (two `@vitest/mocker` advisories, Dependabot). The test runner only: it never ships
  in the Worker, so nothing changes for a running instance.
