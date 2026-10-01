# §16 #18 — Share links are per-view, not per-shelf

**Decided:** 2026-07-18 (reading log (Goodreads redundancy, phase 1)). Cited as `ARCH.md §16 #18`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

New `shares` table: token + name +
captured filters (shelf, media type, status, owned) + sort; a whole-shelf link is
simply a filterless view. Any number of links per shelf, rotated/removed
independently; the public item route enforces the view's filters so ids can't be
walked out of scope. Existing shelf tokens migrated in (0004) so published URLs
survived; `libraries.share_token` remains as a dead column (append-only
migrations, no destructive change). 0003 is an intentional no-op — it was
recorded as applied while still empty, and the harness requires ≥1 statement.
