# §16 #47 — Bulk edit is one batch per action, and deleting in bulk is an admin's

**Decided:** 2026-09-30 (bulk edit). Cited as `ARCH.md §16 #47`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner asked for
bulk edit and decided its shape:
- **Selection**: a checkbox on each row of the shelf table, each card of the covers view and
  each search result, "select all on this page", and an action bar once anything is selected.
  Every media type.
- **Actions**: add or remove a tag (normalized as every tag write is), move to a shelf, owned or
  not owned — copies 1 or 0, the Holding toggle's two moves, with items held in 2 or more
  copies skipped and counted in the result, for #27's reason — and delete.
- **Delete is admin-only**, though any member can still delete one item from its page. A slip
  on "select all" takes sixty books with their reads, reviews and loans. Members never see the
  action, and `POST /bulk` refuses it to them with a 403 and a reason before reading anything,
  so a member never sees the titles it would have listed. An admin confirms first, on a page
  naming the count and the first ten titles, "and M more".

**One route, one plain form.** `POST /bulk` takes `id` (repeated), `action`, `tag`,
`libraryId` and `back`. The checkboxes live in the table and the grid, outside the bar's form,
and join it through `form="bulk"`: the table is never inside a form, because htmx sends an
enclosing form's fields with any request from inside it, and the Holding toggles post from
there. Without JavaScript it all still submits. CSS `:has()` shows the bar once a box is
checked, and shows the tag field or the shelf menu only for the actions that use them; a
browser without `:has()` shows the whole bar all the time, and it still works. `app.js` adds the
count, select all, Clear, and a tag field that's required when a tag action is chosen. The
delete confirmation is a server page rather than `confirm()`: it works without JavaScript, and
it can list the titles. The route redirects to the page it came from — a shelf or a search, and
anything else goes home, so `back` can't be an open redirect — with the counts in the query. The
notice is built from those numbers alone, so a link can't put words on the page.

**One batch per action (#39).** Each action is one `d1.batch()`: a tally `SELECT` first, then
the writes, with the ids as one JSON parameter read through `json_each`, as `refreshReadState`
takes them. Adding a tag creates it, stamps the items it changes and links them in the same
batch. A failure anywhere leaves every item as it was: tests make the last write fail with a
trigger and find no tag created, no link, no timestamp moved, nothing moved or deleted, and no
cover removed. **At most 250 items an action**, refused rather than cut short. A shelf page shows
60 and a search 50, so the cap binds only a hand-rolled post, and it keeps one request to one
small batch. D1: two calls an action (the session check and the batch), three for a move (the
shelf check), at most six for the confirmation page, measured at the cap. The Worker only
parses ids; SQL does the rest.

**As if each were edited alone.** An item an action changes gets a new `updated_at`, and the FTS
triggers re-index it on the same `UPDATE`. An item already as asked is left alone, `updated_at`
included: it counts as "already" in the result. The edit form stamps every save, but a bulk
action saying "3 already had it" shouldn't make those three look edited. No action touches
reads or reviews, so no household summary moves. Delete is the single delete's `DELETE` over a
list, with the same cascades (tags' links, reads, pages, reviews, loans, activity, comments) and
the same `BEFORE DELETE` triggers of migration 0010, row by row. A test deletes two fully loaded
books one at a time and two in bulk, compares every related table and the outbox, and finds the
connection's Returned and BorrowDecline messages in one unbroken sequence. Covers go through
`waitUntil` once the batch has succeeded, as the single delete's do.

**Share links and connections.** Tags, shelf and copies are what share links and connection
views select on, so a bulk action changes what they show. The middleware clears the share-page
cache after it, as after any mutation (#19). Migration 0021's triggers watch `review`, `rating`,
`status` and `completed_on` only, so a move, a tag or a holding change records no activity.
Moved into a connection view, items bring their existing entries under their old ids, which
are below every follower's cursor, so nobody's feed floods. A new follower's first page is by
date and may include them, as for any item in the view. Moved out, their entries are withdrawn
at the next removal check. Tests hold `activity_log` and `member_activity` to the same rows,
ids and dates across a move. No migration.

**Chosen without asking, overrulable:** a selection is one page's, and doesn't carry across
pages; commas in the tag field make several tags, as on the edit form; removing a tag leaves the
tag itself, as the edit form does; over the cap is refused, never truncated; the notice counts
but doesn't name the tag; the route is `/bulk`, not `/items/bulk`, which `/items/:id` would
shadow.
