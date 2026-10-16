# §16 #104 — Now reading & playing: what the household has open, one pinned link away

**Decided:** 2026-10-16. Cited as `ARCH.md §16 #104`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

What was being read lived only on each book's page, and in a shelf filtered by Status or Read by.
What was being played lived only on each game's or record's play log. Nothing answered "what are we
in the middle of?" in one place. The owner asked for it "in the sidebar in a logical place".

**Decided:**

- **One page, `/now`, "Now reading & playing"**, pinned in the sidebar under Overview, beside Add items
  and Search. Pinned rather than folded into the Reading section, because it is a daily stop:
  recording tonight's page, or that the game was played.
- **Reading now:** every open read in the household (a read's own status, `in_progress`, one per
  person per item, never `items.status`), books only. The viewer's own reads come first, then the
  most recently touched (latest page, else start, else when the read was made). Each card gives the
  cover, title and creators. Once the household has more than one member it names the reader ("You"
  for your own). It gives the start date, and the latest page and percent with its bar, as the item
  page draws them. Your own read takes a page from here.
- **Played lately:** the board games and records played in the last 60 days, the most recently
  played first, up to 24. Each card gives its type, the last play's date, how many plays in those 60
  days, and a **Played today** button. Days are the device's (#69).
- **The actions are the item's own routes.** Record posts to `/items/:id/progress` and Played today
  to `/items/:id/plays`, with `back=now`. Without htmx those routes land back on `/now`, or on
  `/now?refused=1` when the route refused, which says so in fixed words; the item's page says why.
  Any other `back` value is no place to go: the item page, as before. With htmx, both swap the item
  page's section as they always did.
- **One D1 call:** the reads with their latest pages, the plays grouped by item, and the household's
  people, in one batch (`nowReadingAndPlaying()`).

**Privacy.** Inside the app only: who is reading what is already the household's to see (the Read by
filter shows the same). Nothing here reaches a share page or a connection, and no new field is
published anywhere.

**Rules out:** a count beside the link (it would cost every page a D1 call); listing a game or a record
as "being read" (they take plays, #54); recording a page into someone else's read from here (the
route refuses it, as it always has).

Touches #41 and #43 (reads, one open per person), #54 (plays), #69 (the device's day), #62 (the
sidebar's pinned links).
