# §16 #30 — Fixed: GHSA-rgj7-g3m4-5g8c (sharp, via libheif), with an `overrides` pin

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #30`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

sharp
0.35.2 bundles a libheif whose image decoders have critical bugs; 0.35.4 carries the
fixed libheif. Not reachable here: sharp arrives only as a development dependency of
miniflare, which imports it lazily to emulate the Images binding — and Nalanda has no
Images binding (a paid Cloudflare feature this project rules out) and processes no
images anywhere, so nothing ever hands sharp an image. Unlike #26, though, the fix is
cheap. miniflare pins sharp exactly, and wrangler and vitest-pool-workers share one
miniflare: wrangler ≥ 4.131 has moved to 0.35.4, but the newest vitest-pool-workers
(0.22.0) still pins 0.35.2, so no version bump clears the tree. `"overrides":
{ "sharp": "0.35.4" }` in `package.json` replaces every copy; the lockfile changes only
sharp and its prebuilt libvips packages, and the suite passes. **Remove the override**
once vitest-pool-workers ships a miniflare that pins sharp ≥ 0.35.4 itself — left in,
it would hold sharp back the next time miniflare moves.
