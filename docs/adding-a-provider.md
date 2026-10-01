# Adding a metadata provider

Nalanda fills in a book, game or record from outside sources: Open Library and Google Books
(books), BoardGameGeek (games, by name), Discogs (records, by barcode), the Cover Art Archive
through MusicBrainz (record covers), iTunes (book covers). A new one — a national library, a
comics database, a different games site — goes in the same way. This is the walking order; the
rules exist already (ARCH.md, [docs/conventions.md](conventions.md), the decision files), this
page only sequences them.

## 1. Before code: the source's terms, and the budget

- **Read the terms.** Some sources forbid storing their images (Discogs, §16 #67), want a credit
  beside their data (BGG's logo, §16 #44; Discogs' line, §16 #63), need a registered token
  (BGG since 2025), or limit the rate (MusicBrainz: one request a second). What they ask for
  decides what you may store, show and how often you may ask. Write it into
  [THIRD-PARTY.md](../THIRD-PARTY.md) under *Data sources*.
- **Keyless if possible.** A secret is one more thing every self-hoster must set
  (`wrangler secret put`, `.dev.vars.example`, the deploy runbook) and one more notice on the Add
  page when it is missing. If the source needs one, the feature degrades to a notice, never an
  error.
- **10 ms of CPU a request.** A provider's answer is parsed on the Worker. Ask for the fields you
  need (`fields=`, a `limit`), measure a big answer (Open Library's forty works with ISBNs is 74 KB
  and parses in 0.17 ms — §16 #78 records how), and prefer JSON; XML goes through
  `fast-xml-parser`, the one XML dependency.
- **No background work.** A provider is asked on a click, on a scan, on a backfill someone runs —
  never on a timer, never while serving a page that didn't ask (§16 #78). Nothing about a
  member's reading goes to a provider: a title, an ISBN, an author's name.

## 2. The module: `src/metadata/<name>.ts`

- Only `src/metadata/` talks to the network. Use `fetchWithTimeout()` and `USER_AGENT` from
  `src/env.ts`; a provider that hangs must not hang the page.
- Implement `MetadataProvider` from `src/metadata/provider.ts` — `id`, `mediaTypes`,
  `lookupByBarcode()` (null when the source has no barcodes), `search()` — or, for a cover-only
  source, one function the cover chain can call (`itunes.ts` is thirty lines).
- Return `Candidate`s: the normalised shape the Add page's confirm form takes. Map what the
  source names to our fields — title, creators ("A, B" for several), publisher, published,
  description, length, ISBNs, `coverUrl` (fetched into R2 only on save, raster only),
  `formats` (codes from `src/lib/formats.ts`), `language` (ISO 639-1 via
  `languageFromProvider()`), `series`. Put the source's own id in `details` (`bgg_id`,
  `discogs_id`) so a later refresh can find the record again.
- **`details` is public** on share pages and to connections: nothing private, nothing you
  wouldn't print on a card, and never money (§16 #61).
- An answer that isn't an answer — a rate-limit, an outage — returns null and is **never
  cached as empty** (§16 #78): the next click asks again.

## 3. Wiring it in: `src/metadata/index.ts`

- **Barcodes** route by kind in `lookupByBarcode()`: EAN-13 starting 978/979 is a book, any
  other EAN/UPC a record. A provider for a new kind of barcode extends `classifyBarcode()`.
- **Names** route by type in `searchByName()`, one page at a time (`PAGE_SIZE`, "More results").
- **Merging**: `mergeBookCandidates()` keeps the first hit and fills its blanks from the next —
  providers are complementary, not competing. A new book source joins the merge; a source for a
  new type gets its own branch.
- **Covers and descriptions**: `findCover()` tries sources lazily until one yields a storable
  raster image; `findDescription()` likewise. Add yours to the chain in the order its quality
  deserves, and remember the Discogs rule — never one of its images, on any path.
- **Refresh**: "Refresh from BGG/Discogs" re-asks the source for one item and writes only if the
  fields it read are unchanged since (`applyGameFill()`, `applyPressingFill()` — the guard in the
  statement). A new source that can refresh follows that shape, and `src/lib/pressing.ts` /
  `src/lib/games.ts` say what a refresh may overwrite.

## 4. The scripts that run it on a laptop

- `npm run backfill:remote` and `npm run record-covers:remote` run `src/metadata` under Node, through
  `scripts/ts-resolve.mjs` and Node's own type stripping. So a provider must be **erasable
  TypeScript**: no enums, namespaces or parameter properties, and no `cloudflare:` imports.
- A source added to `findCover()` or `findDescription()` is used by the backfill without more. The
  backfill paces hosts at 4 requests a second unless `PACE` in `scripts/backfill-remote.mjs` says
  otherwise: a source with a lower published limit (MusicBrainz's one a second, the archive's,
  Discogs', Google Books') must be added there.

## 5. Showing it, crediting it

- The Add page shows a provider's results as cards; "In your catalog" matches by ISBN and by
  title and author (`catalogMatches()`, `booksNamed()`).
- A credit the terms require goes through `src/views/attribution.tsx`: BGG's logo wherever its data
  shows (committed unmodified under `public/bgg/`), Discogs' text beside a record it filled. The
  share page's footer and the item page both ask the same question.
- A missing secret is a `notices` line on the Add page ("Set DISCOGS_TOKEN to…"), not a 500.

## 6. Tests — never a real request

- `test/fetch-mock.ts` stubs outbound `fetch`: `activateFetchMock()` in `beforeEach`,
  `intercept(host, pathPredicate, { body, status })` per answer, `assertNoPendingInterceptors()`
  in `afterEach`. A test that reaches the network fails.
- Keep answers as fixtures (`test/fixtures/<name>.ts`): a real response trimmed to what the
  parser reads, including the odd cases — an empty answer, a 429, a record with two series,
  a game BGG lists after eight others with the word in their names.
- Test the mapping (fields, formats, language, series), the routing (which barcode goes where),
  the merge, the notice without a secret, and the refresh guard.

## 7. Write it down

- A decision file in `docs/decisions/` with its ARCH.md §16 row: the source, its terms, what is
  stored, what is credited, what is ruled out.
- THIRD-PARTY.md (*Data sources*), README's provider line, CLAUDE.md's stack bullet, the deploy
  runbook's secrets table if a token is needed, `.dev.vars.example`.
- `changelog/unreleased.md` — and an **Upgrading** bullet when a secret must be set.
