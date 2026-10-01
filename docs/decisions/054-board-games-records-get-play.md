# §16 #54 — Board games and records get a play log: each play a dated row, the household's, beside — not inside — their reads

**Decided:** 2026-09-30 (the play log). Cited as `ARCH.md §16 #54`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A game's shelf life is how often it comes out; a record's, how often
it goes on. A read (#41) says someone started and finished something, which fits a book and
barely fits a game. The owner decided the shape: a **Played** button on a board game's and a
record's page records a play dated today, with a date field beside it to pick another day; the
page says "Played 12 times · last on 14 Sep" over the five most recent dates, and **All N plays**
lists every one, a hundred a page under a heading per year. **A play is the household's**: no
players, winners, scores or durations — a count, and the days. `logged_by` keeps who pressed the
button, for auditing and for who may **remove** a play: whoever logged it, or an admin — checked in
the route (403 with a reason) and again in the DELETE (`allowed()`, as #43's writes are). Only
admins see who logged each, and only once the household has more than one member. Not for books:
books have reads. The route and the INSERT both refuse any type but `boardgame` and `vinyl`
(`PLAYABLE_TYPES` in `src/lib/plays.ts`).

The design questions, answered:
- **Plays and reads stay apart, and nothing about reads or status changes.** Records and games
  keep the per-member reads the edit form has always kept (#43), and the Reading list their page
  shows in a household of more than one. `plays` is a new table, and nothing on `items`
  summarizes it — no `play_count` column, unlike `read_count`. So a play writes no item column,
  moves no `updated_at`, and fires no trigger: no status filter, share view, connection view or
  activity log can see it. The page counts plays with one indexed statement instead, which the
  budget affords (below). A play is one INSERT with nothing depending on it, so #39's "a write
  and its dependents in one batch" is met by the statement alone.
- **Share pages say how many, never when.** A shared game's or record's own page shows
  "Played N times" from the first play (`playCount`, through `toPublicItem(item, { plays })`),
  always on, like `readCount` — the count is catalogue-level, harmless, and says something about
  the object. Never a date, the last play, or who logged one (§9). The count is looked up for
  every id the item route is asked, in the same `Promise.all` as the item, so a hit still costs
  what a miss does (a test holds a shared game's hit to a miss's D1 calls). Listing cards don't carry it: a
  page of cards would need an aggregate query for a glance's worth of information.
- **Plays don't go to connections — not in this change.** `toConnectionItem()` calls
  `toPublicItem()` without a count, so no `playCount` key; no feed kind, no trigger. If they go
  later, they must follow #45 — resolved at serve time, household entries with no `by` unless
  names are on — and a new feed kind is skipped by older peers (#35), which keep the page.
- **Later work reads the table by its indexes.** `idx_plays_item_played (item_id, played_on)`
  serves an item's count, last and recent plays and "last played" per item (`max(played_on)`
  per group, from the index — "what should we play tonight"); `idx_plays_played_item
  (played_on, item_id)` serves plays in a date range grouped by item ("year in review"). A test
  reads the query plans for both.

**Portability.** The export gains a `plays` column: the dates, oldest first, each with who logged
it as the reads cell names readers — `2025-09-14@asha;2025-09-20@` (percent-encoded; an empty
name a former member; no `@` the importer's). An admin's import gives each play back to the
member of that name, or to the importer; a member's import is all theirs, as #43 does for reads.
An export from before plays has no such column, and its games and records arrive unplayed; a
date that isn't one, or is in the future, is dropped from a cell and the rest kept. A libib file
that happens to carry a `plays` column keeps it out of `details`, which share pages show. Plays
aren't in the import preview's per-name tally: who pressed Played isn't anyone's history.
**Deleting** an item or its shelf deletes its plays (ON DELETE CASCADE); **removing a member**
keeps the plays they logged, unattributed (`ON DELETE SET NULL`, and `deleteUser()` clears it in
its batch too, as it does `reviews.user_id`); only an admin can then remove one. At most 5,000
plays an item (a game a day for thirteen years), in the app and in an import, so no page or
export cell grows without bound. `scripts/backup.mjs` backs the table up after `reviews`.

**Migration 0030** (generated, one CREATE TABLE and two indexes; it was 0028 until 1.4.0's
session-key migrations took 0028–0029, and was regenerated unchanged) touches nothing else.
Rehearsed on a local copy of production's backup of 2026-09-29: 0000–0027, the per-table restore
in `TABLES` order, then this migration — all 34 pre-existing tables (FTS shadow tables included) identical in row counts and row
hashes, all 85 pre-existing schema objects unchanged, `plays` empty, no foreign-key violations,
integrity ok. D1 (budget 50, #37): a game's page is 11 calls (with lending history's), one more than
without plays, however many plays; a shared item page 5, the same for a hit and a miss; an export page 10 once loans (#57) sit beside plays.

**Chosen without asking, overrulable:** only board games and records (not `music`, `movie` or
`videogame`) — one constant; the date defaults to the server's UTC day and may be tomorrow, as a
read's may; "last on" and the list read "14 Sep", with the year only outside the current one;
five recent plays on the page; an item whose type changed away keeps its list (to see and remove)
but loses the button; the share count shows from one play, where `readCount` waits for two — a
single read is what "Completed" already says, and nothing else says a game was played once;
the logger is shown to admins only; the 5,000 cap; plays aren't in the import preview's tally.
