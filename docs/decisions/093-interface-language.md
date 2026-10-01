# §16 #93 — The interface language: one strings table, English the source, Hindi and Tamil machine-drafted and marked so; the interface follows the household's language, a member's own choice over it; a household imports its own translation

**Decided:** 2026-10-01 (built 2026-10-02 as the first step; the table grows a surface at a time). Cited as `ARCH.md §16 #93`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Every word of the interface was English, written where it was shown. A household reading in Tamil
or Hindi (#76 gave the catalogue its languages) still met "Shelves", "Not owned" and "Log out" in
English, and nothing short of a fork could change that. **The owner decided** on one table of
strings with English as the source, a few widely used languages machine-drafted and marked as such
until a native reader checks them — Hindi and Tamil first — and a way for anyone to download the
strings, translate or correct them, and bring them back: as this household's own translation,
imported by an admin, or as a pull request that ships to everyone.

**What was decided:**
- **One table, English the source.** `src/i18n/strings.ts` holds every interface string a covered
  page shows, one key each (`nav.overview`, `pill.not_owned`); `hi.ts` and `ta.ts` are full
  translations of it, each exported with `draft: true` — a machine draft nobody has checked — until
  a native reader sets it false in a pull request. Placeholders are `{name}`, filled by `t()`;
  a count's two forms are two keys, `<key>_one` and `<key>_other`, picked by `n()`; numerals stay
  digits. Never ICU: the table is readable by anyone with a text editor. A key no translation has
  falls back to English, so a page never shows a blank. hono/jsx escapes every string on the way
  out, so a translation — shipped or imported — is text, never markup; where a sentence holds a link
  or a `<strong>`, `Fill` lays the translation's words around slots in the order the translation
  chooses.
- **The interface follows the household's language** (`site_settings.language`, #76) where a
  translation is shipped, else English — a household in French keeps every item in French and the
  interface in English — and **a member's own choice comes first**: `users.locale`, set under
  Account (Language: household default, or a shipped locale, the drafts marked), NULL to follow the
  household. `resolveLocale(user, settings)` is the rule. The `lang` attribute on `<html>` is the
  resolved locale. Share pages carry the household's language, never a member's, and translate only
  their own few strings — badges, "Not owned", "Read N times", the feed's titles — never an item's
  data, never a name.
- **It costs no D1 call.** The session middleware already read the account row; that call is now a
  batch of three statements — the row, the household's language, and the household's own
  translation for the locale the two resolve to, resolved in SQL by the same rule as
  `resolveLocale()` (`sessionAccount()`). No translation for that locale, and the third statement is
  simply empty. A page with no session (log in, setup) reads the household's in one batch
  (`householdLocale()`); a share page reads it in the batch that looks the token up
  (`shareWithLocale()`); Members reads its translations beside the settings
  (`siteSettingsWithTranslations()`). Every page keeps the count it had; test/i18n.spec.ts
  holds the Overview, a shelf and Account to it. The translation is read fresh each request, not
  cached per isolate: an admin's import shows on their next page load, on every isolate.
- **Anyone can download the strings**: `GET /strings/<locale>.json`, signed in, the shipped table
  with the household's overrides merged, pretty-printed; English for a locale that isn't shipped.
  **An admin imports a household translation** under Members: a JSON file read in the browser
  (`public/translations.js`, like the CSV import) and posted as JSON to
  `POST /settings/translations`, at most 200 KB (413 beyond it; 400 for anything that isn't an
  object of key → string, or a locale that isn't shipped); only keys in the table are kept, the
  rest counted as ignored; the `translations` table holds one row per locale (`locale`, `strings`
  JSON, `updated_at`), and the household's strings override the shipped ones key by key — on share
  pages too. Remove clears it. Backups carry the table; `users.locale` is a member's setting, not
  item data, so it is not in the CSV export.
- **The scope of this step** ("step 1 and a bit"): the layout (sidebar, mobile bar, skip link, brand
  line), log in and setup, the Overview, a shelf's page with its filter bar, presets and views bar,
  an item page's labels, pills and buttons, the Add page, Account, Members, Import/export's headings
  and buttons, the Trash, and the share pages' own strings. Left English for later steps, keyed as
  each PR reaches them: the item page's sections (reading, reviews, plays, quotes, series, the buy
  section, history), the item form, bulk edit, the pages beyond these (tags, series, creators,
  publishers, loans, borrowed, wants, goals, year in review, play tonight, search, quotes, shares,
  connections, feed, notifications, recommendations), the long explanations on Import/export and in
  the shelf's share panel, the 404 page, provider notices, and every text a script writes
  (`app.js`, `import.js`, `scan-review.js`). Language names in the item form stay English
  (`src/lib/language.ts`).

**What it rules out:** a translation service or any call out to translate (the drafts are files in
the repository, corrected by people); per-string overrides edited in the UI (a file round-trips,
diffs and ships as a pull request — a form field for each of three hundred strings would not);
translating item data, usernames, display names or anything a member typed (the catalogue is in
whatever language it is in, #76); ICU messages or a plural engine (two keys say what every covered
sentence needs); a per-member language on share pages (a link is the household's); numerals in
local scripts (digits are data, as everywhere in the ledger); a cache of the imported translation
per isolate (an import must show at once, and the batch costs nothing).

Touches §8 (nothing about sessions: the locale rides in the row the middleware reads), §9 (a
share page's bytes change only in its own strings, by the household's choice — never a member's,
never an item's data), §11 (`src/i18n/`, `src/views/i18n.tsx`, `src/routes/strings.tsx`). Tests:
`test/i18n.spec.ts` — the completeness of each draft (every key, the same placeholders, no markup),
`t()`/`n()`/`parseTranslation()`/`resolveLocale()`, `lang` on a signed-in page, a share page and
the login page, the member's choice over the household's, no D1 call more for a translated page,
the download, the import's refusals (403, 413, 400) and that an imported string wins everywhere it
shows, escaped.
