## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Changed

- **Every request shows it is on its way.** The button or form that sent it carries `aria-busy` with a moving
  sheen until the answer is in, so a tap on a slow connection no longer looks like nothing happened. A plain form
  (Save, Lend, Add) refuses a second submit while the first is out (ARCH.md §16 #105).
- **The status columns that move are declared as state machines** in `src/lib/lifecycles.ts`: borrow requests,
  recommendations and connections. Every statement takes its moves from there, and
  [docs/state-machines.md](../docs/state-machines.md) draws them, checked by a test. Nothing changes in what moves
  where.
- **On a touchscreen**, the Edit, Add a past read, Add a cover and History toggles are a finger's height. A read's
  Began and Ended fields say which is which.

### Fixed

- **The camera scanner** no longer opens a second camera on a double tap of Start. It no longer leaves the camera on
  when the camera answers after the 8-second timeout, or after Stop. On a slow connection it loads the barcode
  decoder once, not once per frame, and reads one frame at a time. Its message says why the camera didn't start:
  permission refused, timed out, or no HTTPS.
- **The Add page's review list** no longer misses a barcode held while it was already reading the device's queue
  (scanning fast with Keep scanning on).

- **sharp 0.35.5** (GHSA-wq5f-xc86-pv6w, librsvg). A development dependency only: miniflare uses it to
  emulate the Images binding, which Nalanda doesn't use, so no deployed instance ever ran it on an image.
  The `overrides` pin in `package.json` moves from 0.35.4 to 0.35.5 (ARCH.md §16 #30).
- **Vitest 4.1.12** (two `@vitest/mocker` advisories, Dependabot). The test runner only: it never ships
  in the Worker, so nothing changes for a running instance.
- **undici 7.30.1** (five Dependabot advisories: TLS validation, renegotiation and WebSocket DoS,
  redirect cache poisoning, content-encoding DoS). It reaches the tree only through miniflare (local dev
  and tests), never the Worker bundle; the `overrides` pin in `package.json` moves from 7.29.1 to 7.30.1.
