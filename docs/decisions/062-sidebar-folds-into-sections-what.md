# §16 #62 — The sidebar folds into sections by what you're doing; a device remembers the ones its member opened in a small cookie the server reads, so the first paint is already right

**Decided:** 2026-09-30 (purchase price, and Discogs market value dropped). Cited as `ARCH.md §16 #62`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

(58–61 are
taken by parallel work.) The sidebar had grown to four headed lists — Catalog, Circulation,
Shelves, Data — with Account in the foot, too long for a phone's drawer and grouped by where
things lived rather than what someone came to do. **The owner decided** the groups and how
they behave:

- **Pinned**, in no section and always in view: Overview, Add items, Search.
- **Library**: Tags, Series. **Shelves**: one link per shelf with its count, as before.
  **Reading**: Want list, Reading goals, Year in review (#59). **Lending**: Loans, Borrowed
  (connections only). **Sharing & connections**: Shared links (admins), Feed, Notifications,
  Recommended (#58; these three connections only), Connections (admins, connections only). **Settings**: Import / export, Members (admins),
  Account. Who's signed in and Log out stay in the foot.
- Every section starts **closed**, except the one holding the current page, which is **always
  open**. Sections a member opens or closes are remembered **on that device**.
- Pages that merged while this was in review found their places when main was merged in: Year
  in review in Reading, Recommended in Sharing & connections, beside Feed and Notifications.
  "What should we play tonight" has no sidebar link: #60 links it from the Overview and a
  shelf's header instead.
- A page with no link of its own marks the one it's reached from (`navPath()` in
  `src/views/layout.tsx`): a connected household's pages (`/households/…`) open Lending and mark
  **Borrowed**, where households are browsed from; its feed settings (`/connections/:id/feed`),
  reached from Connections, mark **Connections** (1.6.1).

**Markup.** Each section is a native `<details class="nav-section" data-nav="…">` whose first
child is its `<summary>`: it opens and closes with no script, from the keyboard (Enter and
Space on the focused summary), and assistive tech hears a button that is expanded or
collapsed. A closed section's links are out of the tab order and the accessibility tree
without anything to keep in step. One `<nav aria-label="Main">` holds the pinned links and
every section, instead of a landmark per heading — six would crowd a screen reader's landmark
list. The summary is the old eyebrow label with a CSS chevron (two borders of a small square,
turned from pointing right to pointing down) and a 28px target (34px in the phone drawer), in
existing tokens only; it opts out of the global `details` frame as the toolbar filters do. A
section with nothing in it for this member — no shelves yet, or Sharing for a member on an
instance without connections — isn't drawn at all. The active link keeps `.active` and gains
`aria-current="page"`.

**Remembering, without a flash.** Two ways were weighed:
- *app.js restores open sections from `localStorage` after load*, as the column choices do —
  but app.js is deferred, so the sidebar would paint with everything closed and then grow.
  The column choices avoid that with an inline script in `<head>` because they only set an
  attribute on `<html>`; sections are elements further down the page, which an early script
  can't reach before they're parsed.
- *A cookie the server reads*, **chosen**: `nav=library.reading` — the ids of the sections the
  member opened, joined by `.` (a comma isn't a legal cookie character). app.js writes it on a
  click on a section's header — Enter and Space on a summary click it too — computing the new
  state before the `<details>` toggles; `page()` reads it with `getCookie()` and renders those
  sections `open`, so the first paint is the remembered one and nothing moves after load. It
  costs no D1 call and no work beyond a split.

The cookie holds only what the member chose. A section open because it holds the page is never
written down — only a header click writes — so reading a Tags page doesn't leave Library open
everywhere afterwards; closing it there is written, and it's still open on its own pages. It is
`Path=/`, a year's `Max-Age`, `SameSite=Lax`, `Secure` on https (as the session cookie), and
not `HttpOnly`, since script writes it; an empty set deletes it. It's per device, not per
member: two people sharing a browser share the sidebar's shape, which is a display preference
and says nothing about either. **Validation**: the browser writes it, so the server treats it as
a filter over `NAV_SECTIONS` — the six known ids. Anything else in it is dropped, a value past
100 characters (all six joined are 49) is ignored whole, and nothing from it is ever written
into the page: the only thing it can do is add `open` to a section the member can already see.
A cookie can't open a section the member doesn't have, and can't close the current page's.
app.js keeps only lowercase ids when it rewrites the cookie, and at most eight.

**Unread.** Feed and Notifications keep their per-link counts. A section's header sums its
links' unread counts into the same indigo pill (`role="img"`, `aria-label="N unread"`, capped
at 99+), so the summary is announced as "Sharing & connections, 3 unread". CSS hides the header
pill only while the section is open (`.nav-section[open] .nav-summary-unread`), where each link
shows its own — so it follows a toggle with or without script. The phone's top-bar link to
Notifications or Feed stays as it was.

**Phone.** The drawer is unchanged: `#nav-toggle` opens it, Escape closes it and returns focus,
and closed it's `visibility: hidden`, so nothing in it is tabbable. app.js closes the drawer on
a click on a link or button in it; a summary is neither, so opening a section keeps the drawer
open. Summaries lose the phone's tap highlight, which isn't one of our colours; hover and focus
show state. Checked at 390px wide: no horizontal scroll, and "Sharing & connections" keeps one
line beside its count (the section eyebrow tracks 0.1em rather than 0.14em for that).

**Within the free plan.** The sections are drawn from the shelves and unread counts the layout
already loads; a test counts a page's D1 calls — five for the Tags page, the same as before —
with no cookie, every section named, and junk. No migration, no new dependency.

**Chosen without asking, overrulable:** the cookie's name (`nav`) and `.` separator; recording
only header clicks, so auto-opened sections aren't remembered; a summed count rather than a
dot on a closed header; one `nav` landmark labelled "Main"; leaving empty sections out; the
34px phone target; tighter tracking on the section labels.
