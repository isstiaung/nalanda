# §16 #69 — Today is the device's day: a `tz` cookie names its zone, and every date a page offers or a handler fills in is today there

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #69`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The Worker's clock is UTC, and every "today" was the server's: the date the Finish, Played and
Start forms offered, the day a first page opened a read on, the day a loan was made or returned,
whether a loan was overdue, where a goal's pace stood, which year was "this year". A household
east of UTC reaches tomorrow first — a member in Chennai finishing a book at 2 am had it dated
yesterday — and one west of it is handed tomorrow in the evening. A review of what the app still
lacked against Goodreads and libib (2026-10-01) put it first, as a correctness bug rather than a
feature. **The owner decided** to fix it before anything else on that list.

**What was decided:**
- **The device says where it is.** `public/app.js` writes the browser's IANA zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) into a small `tz` cookie — a year, this
  origin, `SameSite=Lax`, `Secure` on https — exactly as the sidebar's `nav` cookie is written
  (#62), and rewrites it only when the zone has changed. No setting to make, nothing per member
  to store, and a travelling phone is right wherever it is.
- **The server reads it once per request.** `todayOf(c)` (src/views/layout.tsx, beside the `nav`
  cookie's reader) is `todayFor(cookie)` in `src/lib/dates.ts`: the cookie's zone when it is the
  shape of a zone name and the runtime can keep time in it, else UTC; then the calendar day there
  by `Intl.DateTimeFormat` with `timeZone`, which workerd supports (ICU). The cookie is the
  browser's, so it is only ever input: a value that isn't a zone — markup, a stray attribute, a
  made-up name — means UTC, and nothing from it reaches a page. The zone is kept as the cookie
  names it, not as ICU canonicalises it (it answers "Asia/Calcutta" for Asia/Kolkata): either
  keeps the same time.
- **Every date a page decides is that day.** The Finish, Stop, Played and Start forms offer it,
  and a handler given no date records it; a first page recorded opens a read on it
  (`addProgress(…, today)`); a loan is made and returned on it (`lendIfFree`, `returnLoan`,
  `lendToConnection`); the item page, Loans, Borrowed and the Overview count a loan overdue
  against it; a goal's pace, its settable years, Year in review's "this year", game night's "last
  played" and the export's file name use it. Routes never call `new Date()` for a day: `todayUtc()`
  remains for what has no device — tests, imports, and the bound on how late a date may be.
- **The bound stays a day of slack, in UTC.** `latestReadDate()` still allows tomorrow in UTC,
  which is at or after today in every zone, so a device's today is never refused; the cookie can't
  be trusted to tighten it.
- **The triggers need no change.** Migration 0027's and 0036's "today or yesterday" tests, which
  decide whether a finish is news, compare against UTC with a day's slack in the past
  (`>= date('now', '-1 day')`); a finish dated the device's today — at most UTC's tomorrow — passes
  them. An import's "before today" test (0021, 0036) likewise treats the device's today as now.
  No migration.
- **Timestamps stay as they were.** What the ledger shows from a stored `datetime('now')` — when
  an item was added, a page recorded, a review written, a notification arrived — is still the
  UTC moment's date. Converting those needs the zone threaded through every component that
  prints one; a follow-up, if it matters, not this change.
- **The first page a device loads has no cookie yet**, so it offers UTC's day; app.js writes the
  cookie before the next request. A new device at 2 am in Chennai sees yesterday once.

**What it rules out:** a household time-zone setting (an admin's choice, wrong for whoever is
away), a zone per member (stored, and still wrong on a borrowed laptop), and an offset sent with
each form (the forms already send a date; the fix is what the page offers, and what a handler does
when no date comes). SQL's `date('now')` for a user's action: a route passes the day.

`test/today-zone.spec.ts` holds it: the zone a cookie names and the day in it, the forms' offered
date with and without a cookie, each handler's recorded date from a zone whose day differs from
UTC's at the moment the test runs, and app.js's cookie.
