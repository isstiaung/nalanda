# §16 #103 — A phone-sized pass: touch sizes, a shelf's filters in one panel, its items as a list, an item opening on its head

**Decided:** 2026-10-16. Cited as `ARCH.md §16 #103`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner, on a phone, found the app clunky. A shelf opened on three rows of filter controls and a
"Save view" form set at an odd indent, then a table whose Status column ran off the right edge
(it scrolled sideways inside its frame). An item's page opened on its cover at full width, then a
file field and two buttons to replace the cover, with the title below the fold and Edit at the foot
of a long page. Every control was 32px tall with 13px text: small for a thumb, and under the 16px at
which Safari on a phone zooms the page into a field when it is tapped.

**Decided:**

- **Touch sizes, at 880px and under** (the width where the sidebar becomes a drawer): every control
  is 40px tall and sets its text at 16px. The rule of one size for a row of controls (#16) holds at
  these sizes as it does at 32px and 13px on a wide screen. Running text is 15px, table cells and an
  item's properties 14px. The drawer's rows are 40px targets at 15px.
- **A shelf's filters fold behind one Filters button, at every width.** The toolbar is one row: the
  search box, **Filters** (with the number of filters in use on it), Columns and the Table/Covers
  toggle. The button opens a panel (`.toolbar-filters`) under that row, after it in the markup too,
  so Tab meets it where the eye does. In the panel each filter is a `<fieldset>` of its choices in
  sight, never a dropdown inside a dropdown: a ruled pill per choice with its own checkbox inside,
  ticked in more than colour. Read by and the sort follow, then Apply (the panel's one action, so
  primary) and **Clear filters** while any is in use. The panel offers what could match: the types the
  shelf holds (no Type at all on a shelf of one type) and the formats those types come in, in each
  type's own order, plus whatever is already ticked, so it can be unticked. It folds only where
  script can unfold it: the `<head>` marks `<html class="js">` before paint, and app.js opens and
  closes the panel with `aria-expanded`. With no script the panel shows, open. *(First built as a
  phone-only fold of the old dropdown menus; the owner asked for one Filters button with the filters
  inside it everywhere, the same day.)*
- **A shelf's items become a list on a phone.** Same `<table>` and cells in the same order;
  only the layout changes. Each row shows its checkbox, its cover, the title and creators, then
  whichever of rating, status and holding Columns leaves showing. A "—" for an unrated item and the
  Owned toggle on an owned one are left out of the line, since there they say nothing (and the toggle
  was a target under a scrolling thumb). The header keeps select-all.
- **An item's page opens on its head:** title, creators, tags, Want and Edit, in a `<header
  class="item-head">`. On a wide screen Edit sits top right, as a page's actions do. At 880px and
  under the head sits beside the cover (160px wide, 104px on a phone). Delete stays at the foot, alone. Replacing the cover is folded
  behind one quiet "Change cover" line, which opens itself when a photo was refused, so the error is
  seen. Share pages and a connected household's item page get the same cover-beside-title layout from
  CSS alone (their `<hgroup>` is the head). Their HTML is unchanged, byte for byte.
- **The phone's bar carries Search and Add** beside the menu, as icon links each named by its
  label. The wordmark links home, as the sidebar's does.
- **Covers sit three to a row on a phone** (the Overview's latest twenty, the covers view).

**Why this way.** Each change keeps the manuscript ledger (#16): no new colours, no framework, the
existing pills, frames and tokens. Hiding by width is CSS; only the fold needs script, and without it
the panel is simply open. Re-laying the table's cells, rather than rendering a second list for
phones, keeps one markup, one set of tests and one tab order. The accessibility audit (§18) presses
Filters and audits the panel open.

**Rules out:** a separate phone template or a client-side framework for it; a bottom tab bar (the
phone's browser keeps its own toolbar there); controls under 16px text on a touch-width page.

Touches §18 (the audit's phone pass), #16 (control sizes, amended to point here), #47 (bulk edit's
checkboxes in the list), #73 (the cover photo form, now folded), #81 (the saved-views row), #22 (the filters' any-of groups, now in sight in one panel).
