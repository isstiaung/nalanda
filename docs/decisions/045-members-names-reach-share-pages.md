# §16 #45 — Members' names reach share pages and connections only as display names, only while an admin has switched them on — and with both switches off nothing outside changes

**Decided:** 2026-09-29 (names outside the app). Cited as `ARCH.md §16 #45`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

#43 made reading
and reviews each member's but kept the household anonymous outside. The owner asked for names,
under the household's control, deciding each point in turn:
- **The setting is the household's**, set by an admin: two switches beside
  `progress_on_shares`, both off by default — `names_on_shares` (on **Shared links**) and
  `names_to_connections` (on **Connections**). No per-member opt-in.
- **What is shown is a display name**, new and optional, per member: set on their Account page,
  or by an admin under Members. Trimmed, single-spaced, stripped of control and format
  characters (so no bidi override can reorder the text around it) and of fillers that look like
  nothing — but for the zero-width joiner and non-joiner where they join two characters, which
  Persian words, Indic conjuncts and emoji families need — at most 40 characters, *not*
  unique — nothing needs to tell two Sams apart by it — and never a login. A member without one
  stays unnamed. A login username never leaves the app. It is a user field, not an item's, so it
  isn't in `/export.csv`; backups carry it with `users`.
- **Share pages with names on** list each member's rating and review under their display name,
  labelled "A member" without one, as a connection's item page labels it, beside the
  household's average (§9). Reading history stays "Read N
  times", and no read's date appears.
- **Connections with names on** get one feed entry per person — "Priya finished", "Ravi
  rated", "Priya reviewed", "Ravi started", and each page — so two people finishing a book make
  two entries, each with that member's own rating or review; an item page lists everyone's
  rating and review by display name. Names a connection sends render here as escaped text,
  stripped as ours are: a card per person on the Feed, their reviews on their item page.
- **A login never leaves the app — comments and borrow requests included.** Before this, a
  comment or a borrow request carried its author's username (the connections proposal's
  decision 2, when there was no other name to carry). They now carry `outwardName()`: the
  member's display name while `names_to_connections` is on, else "A member". This household's
  own copy keeps the username, as everywhere inside the app.

**Recording always, choosing at serve time.** Names are applied when a page renders or a
connection pulls, never when something is recorded, so switching off hides names from every
later render and pull, and a rename or a removed member (shown unnamed) takes effect at once.
Per-person facts are recorded always, by triggers (migration 0027) on `reads`, `reviews` and
`reading_progress`, into a new `member_activity` table — only while a connection view exists.
A row points at its read, review or page, never at a person, so who did it is resolved at pull
time, and `ON DELETE CASCADE` takes an entry with what it showed. The household's
`activity_log`, its triggers and its ids are untouched — a test drops the new triggers and
shows `activity_log` recorded identically, ids and all. Mixing per-person rows into
`activity_log` was set aside: they would have shifted the household entries' ids, which peers
hold as cursors, and so changed what is served with the switch off.

**No read's dates, even by implication.** A household entry is dated by when it happened (#40),
and a finish by its read's end — but per person, that date *is* the member's read date. So a
start or a finish reaches `member_activity` only as it happens — a read begun or ended today or
yesterday (the server's UTC day), or undated — and is dated now. A past read added later, or
one an import brings, records nothing per person (the household's stream still records it, as
ever), and neither 0027 nor a first view's backfill records starts or finishes: the backfill
holds ratings and reviews, dated by their book's `completed_on` as the household's are, and
pages by their own time. A rating or review is dated now, or inside an import by the book's
`completed_on`, and not at all without one; a rating of 0 isn't one.

**A rename or a move reaches what peers already hold.** Names are resolved at pull time, but a
peer keeps the entries it pulled. So renaming a member — or removing one, who then shows
unnamed — re-keys that member's entries in the same batch (`rekeyMemberActivity()`, §16 #39):
the same entries, dated as before, under new ids. The removal check then withdraws the old
copies and the next pull brings the renamed or unsigned ones. Saving the same name again
changes nothing. An admin moving a read (with its pages) or a review to another member re-keys
just that read's or review's entries (`rekeyMoved()`), straight after the move's UPDATE and
guarded by its `changes()`, so a refused move re-keys nothing; both members' other entries
still say who did them. A finish or a page per person counts that member's own reads
(`readCount`, `readsBefore`), not the household's, so a first read isn't "finished again"
because someone else read the book.

**Two streams, one cursor space.** A connection pulls the household's stream with names off,
exactly as before, and the per-person stream with names on; per-person ids are served offset
by `MEMBER_ACTIVITY_BASE` (2^40), past any `activity_log` id and within a safe integer. A cursor
from the other stream is "past the end" or "before the start", which the existing rule turns
into the newest page — so a switch either way needs nothing from the peer. The removal check
judges ids by range, and one stream is valid at a time: household entries only while names are
off, named ones only while they're on. Switching either way withdraws what the other stream
sent at each connection's next check, so nobody sees an event twice, once unsigned and once
by name. A household is trusted to delete them; one can keep what it already pulled, and the
Connections page says so. Deleting a shelf that takes the last connection view with it clears
both logs, as removing the last view does. On our Feed, a book several people reviewed shows
its one comment thread under the first of their cards.

**The protocol stays version 1** — additive, optional fields only. A feed item may carry `by`
(a display name), and an item page `reviews` (`{ by, rating, review }`, `by` null for an
unnamed member); with names off neither key is present, so every served byte is as before —
tests compare the feed, item pages and share pages with and without display names and the
per-person log. An older version's parser ignores both fields (a copy of it, in
`test/fixtures/`, reads what this version serves) and skips entries of the new kind
`started`, keeping the page, as #35 arranged for unknown kinds. Such a household shows the
per-person entries as the household's, unsigned — two people's finishes of one book merge into
its one card, since it groups by book and kind. D1: with names on and nine members, tests hold a
share item page to 6 calls and a feed pull to 10 (budget 50, §16 #37); a rename is one batch.

**Chosen without asking, overrulable:** display names are not unique and not in the CSV export;
an unnamed member's entries still come one per person, just unsigned; "as it happens" means
today or yesterday, UTC, so a finish marked just after midnight still counts; a comment or a
borrow request is signed "A member" while names are off, though decision 2 had it carry a
name — the switch's label says names don't go out; a rating or review in the per-person
backfill is dated by its book's `completed_on`, as the household's is, since #40 learned that
imports rewrite everything else; names a connection
sends are cut to 40 characters here and a name over 80 rejects its entry; our Feed puts the
name before the verb ("Priya finished") and drops a "started" once pages or a finish follow it.
