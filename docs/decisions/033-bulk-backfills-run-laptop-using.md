# §16 #33 — Bulk backfills run from a laptop, using the app's own matching code

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #33`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

On a 2,000-item
catalog the in-app backfill kept tripping the free plan's per-request limits. First it was
parsing Open Library's full ISBN lists: cover lookups now ask for a lean field set, which cuts
a search from 70 KB to 15 KB, and the batch is 2. Even after that, an occasional request still
failed. `scripts/backfill-remote.mjs` runs the same `src/metadata` under Node, using Node's
native type stripping plus a resolve hook for our extensionless imports, so no bundler and no
new dependency. It paces each provider (Open Library refused this IP's connections at 14
concurrent) and gives each request its deadline only once its turn comes. It stops rather than
record a miss when a provider keeps failing. Covers go into R2 before any row points at them.
It writes only blanks, each UPDATE re-checking its own field; text goes in as
`CAST(X'…' AS TEXT)`, so quotes and semicolons can't break the SQL file. `rehearse` runs all of
it against a throwaway local database and checks the outcome. The in-app backfill stays, for
small top-ups.
