# §16 #50 — Accessibility is checked in two layers, and CI fails on either (§18)

**Decided:** 2026-09-30 (an accessibility audit). Cited as `ARCH.md §16 #50`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner asked for
an automated audit, compatible with eslint-plugin-jsx-a11y "as much as possible", and whether
that works with htmx. It does, in two halves. `npm run lint` runs jsx-a11y's `strict` preset
(plus `anchor-ambiguous-text`, `lang`, `no-aria-hidden-on-focusable`, `prefer-tag-over-role`)
and nothing else over the TSX. `strict` rather than `recommended`: the two differ only in the
allowances `recommended` makes for widgets built from divs and lists, and this app has none,
so they would only hide a regression. `npm run a11y` runs axe-core in Chromium over the whole
app, both themes, 1280 and 390 wide, with the htmx swaps performed and a keyboard walk. Both
are dev dependencies; nothing reaches the Worker bundle.

**Adapting the linter to hono/jsx.** jsx-ast-utils matches prop names case-insensitively, so
`tabindex`, `onclick` and `autocomplete` already read as their React spellings. `for` is a
different word from `htmlFor`, and `settings['jsx-a11y'].attributes` teaches it to the label
rules; `components` maps `RatingSelect` to the `<select>` it renders. `no-autofocus` alone
compares the name exactly, so a `no-restricted-syntax` twin catches `autofocus`; log in,
setup and search keep theirs, each with its reason in a disable comment. No jsx-a11y rule is
switched off. The parser is Babel's (`@babel/eslint-parser`, syntax plugins only): the repo's
TypeScript 7 has no JavaScript API, typescript-eslint needs `typescript` below 6.1 as a peer,
and npm can't give a peer a version other than the root's. These rules need no type
information. ESLint stays on 9 because the plugin's peer range ends there. A second
`no-restricted-syntax` selector says what §18 asks of htmx: `hx-get`/`hx-post` only on forms,
buttons and links.

**What the audit found and fixed:** no skip link; the active sidebar link and the Add page's
Scan/Search/Manual buttons shown by tint alone (now `aria-current`, `aria-pressed`); an
overdue loan on an item's page and an unread notification by colour alone (now words); four
contrast failures (rating stars on light paper, errors in the dark theme, muted text and
indigo pills on a hovered table row); links in running text told apart only by colour (now
underlined); fields named by placeholder or nothing (a shelf's rename box had neither); a
review's own rating select and the details JSON box unnamed; errors not tied to their fields;
empty action-column headers; an h1 → h4 jump in shelf settings; filter-menu checkboxes closer
than 24px; links with `role="button"`; no visible focus on a checkbox (only a 9% tint) or on the
Table/Covers and Scan/Search/Manual toggles (clipped by their frame); keyboard focus dropped to
`<body>` by an htmx swap; share links and a filter menu scrolling a phone's page sideways; the
Members table pushing its buttons off a phone's screen. The barcode scanner already had its
non-camera path, a typed barcode through the same lookup; it now has a visible label and the
intro names it.

**Chosen without asking, overrulable:** axe-core injected directly rather than through
`@axe-core/playwright`, and the `playwright` library rather than its test runner — one fewer
package, and the audit is a script with a report rather than a test suite; axe's
best-practice rules on top of the WCAG tags, because they check the structure screen-reader
users move by (and the owner's heading-level control needs heading-order), none disabled; the
dark theme's `--ink-3` lifts a shade (`#8f846d` → `#968b73`) and a hovered row keeps half its
tint, with a 2px indigo rule at its left edge so the hover still shows, rather than darkening
the hover or every muted label; light-theme stars mix in 20% ink,
as the in-progress pill does, while the lamp-lit gold is left alone; ratings still read to a
screen reader as star glyphs — a text alternative would touch eleven call sites that
parallel branches also edit, so it waits; the Add page's lookups need Open Library, and when
they find nothing the report lists them as not audited instead of failing
(`A11Y_REQUIRE_LOOKUP=1` makes it fail, and CI doesn't set it, so an Open Library outage can't
block a pull request); a filter menu's run checks target size for the menu's own checkboxes
only, with the controls the menu is on top of set invisible for that run, since axe counts them
as neighbours though no one can tap them (the page under the menu is measured uncovered);
a filter menu near a phone's right edge lines up with its button's right edge (app.js).
