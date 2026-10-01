# §16 #14 — Goodreads CSV import is match-and-merge

**Decided:** 2026-07-18 (reading log (Goodreads redundancy, phase 1)). Cited as `ARCH.md §16 #14`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

, not insert-only like libib (§6): match
by ISBN-13 → ISBN-10 → normalized title + first-author surname (series suffixes,
subtitles, and initials-spacing stripped — Goodreads titles carry "(Series, #1)"
that provider-sourced titles don't). On match, **Goodreads wins** for rating,
review, status, read date, private notes (user's call — Goodreads is the current
source of truth), but absent values never blank existing ones and copies/metadata
are untouched. Ratings map 0–5 whole stars → half-star scale ×2 (0 = unrated);
`Exclusive Shelf` → status (read/currently-reading/to-read, custom dnf/abandoned
shelves → abandoned); ISBNs are unwrapped from Excel guards (`="…"`). Format is
auto-detected server-side per batch, so /api/import needs no format flag and the
same endpoint serves both importers. *Amended by #41:* status and the read date now
arrive as reads, which a merge adds and never removes — Goodreads still wins for
rating, review and notes. *Amended 2026-10-01 (review before 1.8.0):* the title stem is
normalised by Unicode letters and digits, not ASCII — the old rule reduced every Tamil,
Cyrillic or CJK title to "", so two books by one author matched on the surname alone — and
a row whose stem is empty matches nothing. A subtitle after ":" is still dropped (so "The
Dispossessed: An Ambiguous Utopia" meets "The Dispossessed"), but a title-and-author match
now needs the whole first-author name to agree, its tokens compared as a set with initials
ignored (a name that is only initials keeps them), so "Ursula Le Guin", "Ursula K. Le Guin"
and "Le Guin, Ursula K." all agree, as "N. K. Jemisin" and "N.K. Jemisin" do: Brian Herbert's
"Dune: House Atreides" no longer merges onto Frank Herbert's "Dune". `TitleIndex` in src/db/queries.ts carries the rule for
the three merging imports, the Kindle import (#77) and Discover (#78).
