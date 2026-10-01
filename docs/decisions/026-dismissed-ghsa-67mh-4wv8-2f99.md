# §16 #26 — Dismissed: GHSA-67mh-4wv8-2f99 (esbuild dev server), tolerable risk

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #26`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The advisory
lets any website read source off `esbuild --serve`. Not reachable here: nothing in
this project invokes esbuild directly — it is a bundler *library* under wrangler,
vitest and drizzle-kit, and both dev servers (`wrangler dev`, the vitest pool) serve
through workerd/miniflare, so esbuild's HTTP server never starts. Development scope,
so it never enters the Worker bundle either. Unfixable by upgrading: the vulnerable
copy is `esbuild@0.18.20`, pinned four levels down by
`drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils`, a package
deprecated in favour of `tsx` that will not ship a fix — the tree's other three
esbuild copies are already patched. An `overrides` pin was rejected as more likely to
break drizzle-kit's loader than to prevent anything. Revisit if this project ever
runs esbuild's server directly, or when drizzle-kit drops the `@esbuild-kit` chain.
