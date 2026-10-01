# §16 #82 — Borrowed from someone not on Nalanda: an item not owned, with a borrow record — the mirror of a loan, private like one

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #82`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A book borrowed from a friend was either left out of the catalog or added as a plain Not owned
entry with the lender in the notes. **The owner decided** it is an item in the catalog — it
carries reads and a review like any — with a borrow record rather than tags ("a tag can't hold a
date"), that it exports in the items CSV, and that the Borrowed page, connections-only until now,
becomes the one place for both kinds of borrowing.

**What was decided:**
- **A `borrows` table** (migration 0048), the mirror of `loans`: lender, contact, borrowed on,
  due back, returned on, note; `ON DELETE CASCADE` from the item. **Only on an item not owned**
  (`copies = 0`) and **one open borrow at a time**, both checked in the insert
  (`borrowIfNotOwned()`); the route refuses an owned item with a reason. Recorded from the item's
  Circulation section — "Borrowed from", contact, due back, note, where a Not owned item said only
  "nothing to lend" — and returned there or on the Borrowed page (`returnBorrow()`, dated by the
  device's day, #69). The past borrows stay listed under the open one; the form comes back once
  it is returned.
- **Shown wherever "Not owned" is, inside the app:** a **Borrowed** pill (the stamp colour, like
  Lent) beside Not owned on the item page, on shelves, in search and on cards, read in
  `shelfFlags()`'s batch — no call added; and the household's **Holding** filter gains **Borrowed
  from someone** beside Owned and Not owned. With Borrowed among its choices the filter is any-of
  and **in the app only**: it rides in `StaleFilter.holding`, outside `ItemFilters`, so a share
  link still captures `owned` alone and can never say what is borrowed from whom.
- **The Borrowed page is for every household.** `/borrowed` and its sidebar link no longer need
  connections: it lists what is borrowed from people — out now, overdue flagged in words and by the
  pill, Mark returned — and what was returned; where connections are enabled, the sections it had
  (from connections, requests, their shelves) follow. The Loans page is unchanged: what goes out.
- **Private like loans.** Never on a share page — `toPublicItem()` has no key for it — and never
  to connections (`toConnectionItem()` neither); a share page's bytes are the same with a borrow
  recorded and without. The lender's name is a string the household typed, shown only inside the
  app.
- **Round-trips.** The export's `borrowed` cell is written and read exactly as the `loans` cell
  (`formatLoansCell()`/`parseLoansCell()`, the lender in the borrower's place, #57), after
  `quotes` so older columns keep their positions; the import maps it; the trash snapshot carries
  the borrows and the restore brings them back; `npm run backup` lists the table after `items`.
- **What it leaves alone:** marking a borrowed item owned (the Holding toggle) keeps the open
  borrow row — the pill goes, since it shows only while not owned — and nothing is inferred from
  it; a borrow from a connected household stays a `borrowed_items` row, made by a request, with
  its own section.

**What it rules out:** tags for borrowing (no date, no lender); a borrow on an owned item; two
open borrows of one item; a lender who is a member (that is a loan between members, out of
scope); borrow reminders (deferred by the owner).

`test/borrowed-from.spec.ts` holds it: recording from the page by a member, refused on an owned
item and while one is open; the item page's pill, line and history; the pills on a shelf, in
search and on cards; the Borrowed page without connections, overdue flagged, Mark returned from
either place; the Holding filter alone and combined, never a key of the publish form; the export
cell, its parse back and the trash round trip; a share page's bytes unchanged; the sidebar's
Borrowed link on a household without connections.
