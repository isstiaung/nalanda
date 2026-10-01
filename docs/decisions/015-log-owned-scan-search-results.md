# §16 #15 — "Log — not owned" on scan/search results

**Decided:** 2026-07-18 (reading log (Goodreads redundancy, phase 1)). Cited as `ARCH.md §16 #15`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

— the ongoing Goodreads replacement:
every add-flow candidate card gets a second submit that presets `copies = 0` and
redirects to the edit form (not the detail page) so rating/review/status/read date
go in immediately. Same `POST /items` handler, one extra form field.
