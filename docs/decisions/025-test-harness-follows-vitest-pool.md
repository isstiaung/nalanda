# §16 #25 — The test harness follows vitest-pool-workers, and owns its own fetch mock

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #25`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The
v0.8 → v0.20 jump (forced by wrangler 4.119 peering on workers-types v5) removed four
things at once: `defineWorkersConfig` and the `/config` export (now a plain Vitest
config plus a `cloudflareTest()` plugin), `ProvidedEnv` (now `Cloudflare.Env` by
declaration merging in `test/env.d.ts`), automatic per-test isolated storage (now an
explicit `reset()`, so `test/apply-migrations.ts` wipes and re-migrates before every
test — the suite assumes a clean catalog, e.g. `holdingsByType` counts globally), and
`fetchMock`, which vanished from both `cloudflare:test` and miniflare 5.
`test/fetch-mock.ts` replaces it with a global `fetch` stub — viable because the pool
runs the worker under test in the *same isolate* as the test — and deliberately keeps
the two properties that made the original trustworthy: an unmatched request throws
rather than reaching the network, and unconsumed interceptors fail the test. Bundled
codemod not used: it only rewrites the object form, and ours builds migrations async.
Lesson recorded in `.github/dependabot.yml`: group minor/patch, never majors.
