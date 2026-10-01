# §16 #49 — Each member can set a reading goal; connected households hear when it's set, passes halfway and is reached — signed, as it happens, never backfilled; and a new instance starts with names and goals on

**Decided:** 2026-09-30 (reading goals, shared, and new defaults). **Amended 2026-10-02:** the Overview's pace is measured against the device's day, not the server's UTC day, since #69 (`todayOf(c)` is passed to the meter) — the "chosen without asking" line below predates it; the milestone triggers' "today or yesterday" is still UTC, as #45's rule is. Cited as `ARCH.md §16 #49`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner decided each point:
- **A goal is N books in a year, per member** (`reading_goals`, one per member per year). What counts
  is every finished read of a book — not a record or a game — by that member with its end date in
  that year, re-reads included; an undated finish is in no year. The count is never stored:
  `goalCountSql()` works it out when asked, so a read added, corrected, moved or deleted counts at
  once. The Overview shows the signed-in member's goal for this year — "14 of 24", a pace pill ("on
  pace", "3 behind pace", "2 ahead of pace", reached) and a bar with a tick where a year-long pace
  stands today, explained in words under the bar ("The mark shows where you'd be reading evenly
  since 1 January") since the bar is hidden from assistive tech. Pace is linear from
  1 January, whenever the goal was set: by the end of day d of a D-day year, d/D of the target,
  rounded down, so a goal is on pace until it is a whole book behind or past. (1.6.0 said "on track"
  and "3 behind"; a goal set on 30 September read "7 behind" with nothing saying behind what — the
  owner kept the 1 January pace and had it named instead.) A goal can be set for this year or next (`/goals`); earlier ones stay,
  to look back on or delete. Members set their own, admins anyone's — checked in the route (403 with
  a reason) and in the statement (`allowed()`), as #43 does for reads. A member's goals go with them
  when they are removed.
- **Goals reach connections as per-person entries** — `goal_set` (a new goal, or a new target),
  `goal_halfway` (half the target in whole books, rounded up) and `goal_reached` — each carrying
  `{ by, year, target, count }`, the target and count when it was recorded. **Only members with a
  display name** produce one: there is no "A member reached their goal".
- **A switch, `goals_to_connections`**, admin-only on **Connections**, under the names switch. It
  takes effect only while `names_to_connections` is on — a goal entry is always signed — and the page
  says so and greys it out until then. Off withdraws goal entries at each connection's next check.
- **New defaults, same instance.** A new instance starts with `names_on_shares`,
  `names_to_connections` and `goals_to_connections` on; an existing one keeps exactly what it has.

**Recorded as it happens; rows point at the goal.** A goal set is recorded by its own write
(`setGoal()`), in the same batch (#39), guarded by `changes()` so a refused or unchanged save records
nothing. A milestone is recorded by two triggers on `reads` (migration 0036) on **the finish that
carries the count over the line** — before this finish below the threshold, after it at or above —
and only for a finish "as it happens" by #45's rule: ended today or yesterday (UTC), outside an
import, while a connection view exists. A past read added later, an import, or an undated finish can
move the count but crosses no line on anyone's feed; nothing is ever backfilled — not by 0036, not
by a first view's opening entries, not when a switch or a name comes on later. Everything is dated
when it was recorded, never by a read. A `member_activity` goal row points at `goal_id`, never at a
person: the name is resolved when served, from the goal's member, and `ON DELETE CASCADE` takes the
entries with their goal. As #45 does, entries are recorded whatever the switches say and chosen at
serve time (`memberStillShows(goals)`): a goal entry goes out only while goals and names both go to
connections, its member has a display name, its goal still asks for the target it carries, and —
for a milestone — the finish that crossed the line is still a finish. A third trigger deletes a
milestone once that finish stops being one — stopped, reopened, or re-dated out of the goal's year —
as a deleted read's cascade does: left hidden, it held the goal's one row of that kind and turned
away the finish that genuinely reached the goal later (found by the adversarial pass).

**No read's date, even by implication.** A milestone keeps the finished read that crossed the line
(`read_id`, `item_id`), and goes only to views that hold that book — where that finish is already
news, recorded the same moment by 0027's trigger — so a view that doesn't carry the book learns
nothing about when it was read. A `goal_set` has no item and goes to every view that can hold books
(any view whose media type is books or everything); a view of records or games carries no goals.
What a count does say: how many of the member's finishes ended in that year, at the moment of the
entry. Two entries' counts differ by the finishes recorded between them — which can include a past
read added in between — so a peer can learn that such a read ended in that year, never which book or
when: year granularity, the goal's own. Accepted as the owner's "each carries the count".

**Changing, deleting, renaming.** A new target re-keys the `goal_set` (INSERT OR REPLACE on the
unique (goal_id, kind) index: a new id, so a connection holding the old one withdraws it at its
check and pulls the new), and deletes the old target's milestones — "reached" a goal that now asks
for more isn't true; a halfway already passed isn't announced late. Deleting a goal deletes its
entries. `rekeyMemberActivity()` (rename, a name set or cleared, removal) covers goal rows, copying
every column (`MEMBER_ACTIVITY_COLUMNS`), so peers withdraw the old name's copies and pull the new
name's — or nothing, for a member left unnamed. `rekeyMoved()` leaves goal rows alone: a milestone
is the goal's member's news, whoever its read belongs to after a move. `setGoalsToConnections()`
re-keys every goal row when the switch actually changes, so switching back on brings them past each
connection's cursor instead of stranding them behind it.

**Backwards compatibility — the argument.** Goal entries are the first entries with no item. In
plain words: since before 1.2, a household's receiving code reads a feed page entry by entry and
throws away any entry it doesn't understand, keeping the rest. `parseFeedEntry()` rejects an entry
whose kind isn't one of the kinds it knows, or that has no item it can read; `parseFeedPage()` keeps
the other entries and the page's `latest`; `refreshSubscription()` stores what parsed, charges the
daily allowance only for that, and records `cursor: page.latest` whatever it kept. So a household on
1.3.0 or older that pulls a page with goal entries in it skips each goal entry — twice over: `goal_*`
isn't a kind it knows, and there's no item — shows everything else as before, and moves its cursor
past the goal entries, so it never asks for them again. Its removal check sends only ids it stored,
so it never asks about them either. Nothing breaks, nothing repeats; it simply never sees goals.
This version accepts item-less entries **for the goal kinds only** — every other kind still needs a
valid item, as ever — and validates a goal as it validates everything a connection sends (a name, as
`parsePeerName()` cleans it and required; year 1000–9999; target 1–1000; count 0–100,000). The
receiver stores a goal entry under item 0 with no stamp, its goal where the item JSON would be, and
the Feed renders it as escaped text on a slim card with no cover or thread; the same goal arriving
through two followed views shows once. Tests pin all three directions: **v1.3.0's own parser**
(`git show v1.3.0:src/federation/items.ts` and its `parseFeedPage`, in `test/fixtures/items-v1.3.0.ts`)
reads a page this version serves and keeps the item entries, drops each goal entry and keeps
`latest` past them; this version reads goal entries and still refuses an item-less entry of every
other kind; and this version pulls a page built with 1.3.0's own serializer, and a newer one's goals,
and shows both. Nothing else a peer sees changes shape — the descriptor, an item page and the check
serve byte-identical responses with goals on or off, a test compares them — and **the protocol stays
version 1**.

**The migration.** `member_activity.item_id` becomes nullable, which SQLite can't do in place:
0036 rebuilds the table — create, copy with every id, drop, rename, re-index — dropping 0027's five
triggers first (SQLite checks every trigger that names a table when one is renamed) and making them
again word for word after. It carries over AUTOINCREMENT's high-water mark too: connections hold
these ids as cursors, and a plain copy would restart the sequence at the highest id still there,
reusing the ids of the newest entries deleted since. A placeholder row at the old `seq` sets it and
is deleted at once; `sqlite_sequence` is read, never written. The milestone triggers are made before
0027's are made again — SQLite fires the newest trigger first — so a finish's own entry gets the
lower id than the milestone it makes. Then the defaults: `INSERT OR IGNORE` of a `site_settings` row
with the old defaults (progress on shares off, progress to connections on, names off, goals off),
only where there are users. **A new instance** migrates before `/setup`, has no users, gets no row,
and runs on `SITE_DEFAULTS` — names and goals on. **An existing instance** that never saved a
switch had been running on the old defaults; the row writes them down. One that saved one keeps its
row; 0035's new column gives it goals off. `outwardName()`'s SQL fallback follows `SITE_DEFAULTS`.
Restoring a backup from before goals therefore restores at its own level and migrates after, as the
backup runbook says: migrated first on an empty database, 0036 finds no members and the restored
instance would start with names on. 1.4's session keys (#56, 0028–0029) don't touch it: the pin asks
only whether any user exists. 0036 is `--custom`, so its snapshot was written by hand to the new `member_activity`
shape; `drizzle-kit check` doesn't compare snapshots with the schema, but `drizzle-kit generate`
against a copy reports no changes — the pass found the first snapshot stale, which would have made
the next `db:generate` emit a failing rebuild.

**Rehearsed** on production's backup of 2026-09-30 (taken on 1.4.0: 0000–0029, the per-table restore in
`TABLES` order — `series`, `plays` and `reading_goals` have no file and were skipped — then 0030–0036,
so the location, series, plays and vinyl migrations ran with these): 29 of 29 pre-existing tables
identical in every pre-existing column (5,025 rows — 1,999 items, 381 reads, 359 reviews, 303 household
entries, the one per-person entry and its `seq` of 2 kept, both accounts with their session keys).
Its saved `site_settings` row — names to connections **on**, as production has had since 1.3.0 — came
through byte for byte, `updated_at` included, with goals off. The same backup with its row taken away
before migrating got the pinned row: progress on shares off, progress to connections on, names off,
goals off. 0027's five triggers were remade with identical text, and `foreign_key_check` was clean.
None of 0028–0034 touches `member_activity`, `site_settings` or their triggers (0032 remakes only
the search index's). Before the rebase onto them, the same held on the backups of 2026-09-29 and
2026-09-28. D1: the Overview is one call more than before — 11 in all with the layout's and read
next's (#46); a feed pull with eight members' goals and milestones 6, its check 4 (budget 50, #37).

**Goals stay out of `/export.csv` — the owner's decision, a deliberate exception** to "every
user-visible field round-trips through the export" (CLAUDE.md). The CSV is one row per item, and a goal
is about a person, not an item — like a display name, which isn't in it either. Backups carry
`reading_goals` with every other table, and a restore brings them back.

**A line crossed without news is announced by the next live finish** (the owner's choice, after
nalanda-review found an imported or back-dated crossing was never announced): a finish that is news
records the milestone the count now stands at or past — "reached 5 of 4" — once per goal, through the
(goal, kind) unique index. A line the goal's own `goal_set` entry already reported the count at or past
(a target changed mid-year: "2 of 4" says halfway) isn't news again.

**Chosen without asking, overrulable:** a goal can be set for this year or next only; pace counts
the server's UTC day and is "on pace" until a whole book behind or ahead; "halfway" is half the target
rounded up, and a finish that reaches the target is only "reached"; a milestone stays
while its finish does, even if the count later dips; a goal goes to every view that can hold books
and a milestone only to views holding its book; goal entries are recorded for unnamed members too
and served once they have a name (a rename re-keys them), as #45 serves a named member's history;
a member's goals are deleted with them; the shared item page now looks up
members' reviews whatever the switch says, so a hit still does no more D1 work than a miss with
names on, which is now the default. The existing suite runs as a new instance, names on; tests
about names off say so with `upgradedSwitches()`.
