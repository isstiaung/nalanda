# §16 #19 — Share pages are burst-shielded by a per-isolate memory cache

**Decided:** 2026-07-18 (reading log (Goodreads redundancy, phase 1)). Cited as `ARCH.md §16 #19`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

(TTL 1 h,
raised from the initial 60 s by owner's call — public pages change rarely).
They are the many-readers surface and D1's read quota is shared with the
authenticated app — a hot link must not degrade the household's own use.
Mechanism chosen over (a) edge Cache API / `s-maxage` — a **no-op on
workers.dev domains** (no zone; becomes a worthwhile second layer if a custom
domain lands) — and over (b) materializing view JSON to R2 — write
amplification (every edit fans out to every affected view × page), unbounded
staleness on any missed invalidation hook, and a second data store violating
the D1-as-only-source invariant. **Writes invalidate, coarsely**: any
successful mutation clears the handling isolate's cache (index.ts →
`clearSharePageCache()`), so the household's own edits go public immediately;
untouched isolates converge within the TTL or on eviction. Accepted cost of
the long TTL: a rotated/removed link can keep serving from an untouched
isolate for **up to an hour**. `x-cache: hit|miss` header aids debugging;
hit/miss/bust regression-tested in test/items.spec.ts.
