# Adding a column to items

A field on an item touches more of Nalanda than the form it is typed into. This is the walking
order — every rule here already exists; this page only puts them in sequence. Formats (#75),
language and original title (#76) and the purchase price (#61) are three columns added this way;
their decision files in [docs/decisions/](decisions/) show each step done.

## 1. Decide what it is before touching code

- **Is it the item's, or the household's copy's, or a member's?** The title is the item's; `copies`,
  `location` and a record's condition are this household's copy; reads and reviews are a member's and
  live in their own tables, never on `items` (ARCH.md §16 #41, #43). A member's thing is not a column.
- **Is it public?** A column is private until a decision says otherwise. [docs/privacy.md](privacy.md)
  lists what never leaves the app — notes, location, loans, copies, money, condition, who read what.
  If the field should show on share pages or to connections, that is a decision to write down
  (step 9), not a mapper to extend.
- **Could it go in `details` instead?** No, if it is private: `details` is published. A private
  value gets its own column (that is why condition and price have columns, §16 #55, #61).

## 2. The schema and its migration

- Add the column to `items` in `src/db/schema.ts`, with a default for the rows that exist — and for
  the rows a restore of an older backup brings back: the backup carries column names, so a restored
  row takes the new column's default.
- `npm run db:generate` writes `migrations/NNNN_<name>.sql`. Never hand-edit it; never edit a
  migration that has been applied anywhere. The number must follow the last one on `main` when
  you merge — regenerate if another PR landed first.
- Anything Drizzle can't express (a trigger, an FTS rebuild) goes in `drizzle-kit generate --custom`.
- `Item` and `NewItem` are inferred from the schema; the type flows from here.

## 3. The form and the page

- `parseItemForm()` in `src/routes/items.tsx` reads the add and edit forms: parse, bound and
  normalise the value there (a number that must be whole, text with its whitespace collapsed).
- `ItemForm` in `src/views/components.tsx` renders the field: a `<label>` around it, `invalid()`
  when a refusal names it, and a refusal re-renders the form with what was typed (status 400).
- The item page shows it in the `<dl class="props">`, monospace for data (`class="mono"`).
- Any other write path that should carry it: the scan's add, "Log — not owned", imports (step 4),
  bulk edit if it is a bulk kind of field.

## 4. Round trip through the CSV — the column isn't done without this

- `EXPORT_COLUMNS` and `itemToCsvLine()` in `src/lib/csv.ts`: the column goes **just before
  `details`**, which stays last — formats, editions, language, original title, quotes and borrowed
  all went there. The import reads by header name, so position is convention, not compatibility.
- `mapNalandaRow()` reads the cell by name; a missing or blank cell — an export from before the
  column — reads as the column's default, so an older file still imports. Its `details` come from
  the `details` cell alone: nothing in a Nalanda export falls through into them.
- libib, Goodreads, StoryGraph and LibraryThing mappers: map it when the source has it; otherwise
  make sure their unknown-column fall-through can't put a *private* value into `details`
  (`KNOWN_*` sets, §16 #87). On a **match**, `mergeImportItems()` writes only the rating, review,
  notes and reads — an imported value for a new column lands on new items only.
- A value a provider can supply arrives through `Candidate`, the Add page's confirm form and what
  "Refresh from…" may write (`src/lib/pressing.ts`, `src/lib/games.ts`): see
  [adding-a-provider.md](adding-a-provider.md).
- `test/csv-roundtrip.spec.ts` has the pattern: create an item with the value, export, import into
  another shelf, compare.

## 5. A filter, if it is one

- A column a shelf can filter by goes through `ItemFilters` and `itemFilterWhere()` in
  `src/db/queries.ts`, and `parseShelfQuery()` in `src/routes/libraries.tsx`, which reads the bar's
  URL and a saved view's stored query alike (§16 #81) — so a saved view carries it for free.
- Share links capture `ItemFilters` (`shareFilters()`), and the public item route checks the same
  thing item by item (`itemMatchesShare()`): **the twins must agree**, and a test holds every share
  kind to it. A **private** column is never a filter a share link or a connection view may capture
  — `q` matches `location`, "Read by" says who read what, the decluttering filters say when things
  were bought and played — so those live outside `ItemFilters` (`ReaderFilter`, `StaleFilter`),
  where `shareFilters()` has no room for them. Formats (#75) is the worked example of a public one.

## 6. The trash

The trash snapshot (`trashPayloadSql()` in `src/db/queries.ts`) takes every `items` column from
the schema, so a new column is carried and restored without a change. Check the restore test
still passes; if the column has a foreign key, the restore needs the same care `series_id` gets.

## 7. Share pages and connections — only if step 1 said so

- `toPublicItem()` in `src/lib/share.ts` is the whitelist for share pages, `toConnectionItem()` in
  `src/federation/items.ts` for connections, `toGiftItem()` for gift lists. Add the key only with
  the decision from step 1, and never a private one.
- A new key to connections is optional on `ItemDetail` for older peers, and the fixtures in
  `test/fixtures/*-v1.x.ts` carry an `Omit<…>` so an older peer's shape still type-checks.
- A test that a share page's bytes are **unchanged** when the column is private is cheap and
  decisive (`test/share.spec.ts` has several).

## 8. Search, history, feeds

- Full-text search indexes `title`, `creators`, `description`, `notes`, `location` and
  `original_title` only. A new text column worth searching needs the FTS5 index rebuilt in a custom
  migration, as 0045 did — and a thought about whether share links could ever capture a query on it
  (they must not: `q` matches `location`).
- Item history (§16 #84) records the columns its trigger names (migration 0050). A column worth a
  history line is added in a new custom migration that recreates the trigger with it.
- A share link's feed (§16 #86) is the whitelist again; nothing to do unless step 7 added a key.

## 9. The budget

A column read on a page the page already loads costs nothing. A column that needs its own query
costs a D1 call: fold it into an existing batch (`itemPageLog()`'s `extra`, `shelvesWithTotals()`),
and run the budget tests — several pin a page's call count (`test/purchase-price.spec.ts`,
`test/read-next.spec.ts`, `test/session-identity.spec.ts`).

## 10. Write it down

- A decision file `docs/decisions/NNN-<slug>.md` and its row in ARCH.md §16: what was decided,
  what it rules out, which test holds it.
- `changelog/unreleased.md`: the entry, and an **Upgrading** bullet naming the migration and
  "back up first".
- [docs/privacy.md](privacy.md) if the column is private, by surface; CLAUDE.md's invariants if it
  is a new kind of private thing.
- The runbooks, if an operator's step changed (the backup's table list, an import's mapping).

## 11. Before the PR

`npm run typecheck`, `npm run lint` (a labelled field, no `hx-*` off forms and buttons), `npm test`.
CI runs the accessibility audit; a new field on a form joins it by being on the form.
