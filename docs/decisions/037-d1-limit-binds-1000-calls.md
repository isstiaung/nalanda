# §16 #37 — The D1 limit that binds is 1,000 calls per invocation, and a batch is one call

**Decided:** 2026-09-28 (measured, not assumed). Cited as `ARCH.md §16 #37`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Every
design since the connections build assumed the documented free-plan figure — 50 queries per
invocation, each statement in a `batch()` counting separately. Production imports running
~300 statements per request contradicted that, so a throwaway Worker with its own empty D1
database measured it: 1,000 separate `SELECT 1` calls in one invocation passed and the
1,001st failed ("Too many API requests by single Worker invocation"); a single 2,000-statement
batch passed; 1,001 two-statement batches failed on resources (1102), not on the count. The
probe was deleted afterwards and never touched Nalanda's data. Designs keep 50 as their
budget — conservative, and possibly what binds on another account — but a batch is no
longer counted per statement.
