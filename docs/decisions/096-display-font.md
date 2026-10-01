# §16 #96 — A household's own display font: one per shipped locale, uploaded by an admin under Members, stored in R2 under a random key, public at `/fonts/<key>`, set in front of Eczar on every page in that language

**Decided:** 2026-10-02. Cited as `ARCH.md §16 #96`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Titles and the brand are set in the shipped faces — Eczar, its Devanagari subset, Tiro Tamil behind
it for Tamil (#93). A household reading in Hindi or Tamil may well have a face it prefers for its own
script, and short of a fork there was no way to use it. **The owner decided** (2026-10-02): beside the
shipped faces, let the household bring a display font of its own, chosen per interface language,
uploaded by an admin from the language section on Members.

**What was decided:**
- **One font per shipped locale**, in a `display_fonts` table (migration 0058): `locale` (the key —
  `en`, `hi` or `ta`), `key` (the R2 object's key, a random UUID), `format`, `name` (the file's name
  as uploaded, cleaned: its last path segment, no control or bidi-override characters, at most 80
  characters) and `bytes`, with `uploaded_at`. Uploading for a locale that has one replaces it. Only
  an admin uploads or removes one — the routes live under `/settings/*`, behind the admin-only
  middleware — and the name and size are shown on Members alone.
- **Formats and caps.** WOFF2, WOFF, TrueType and OpenType (CFF), read from the file's first four
  bytes — `wOF2`, `wOFF`, `0x00010000` or `true`, `OTTO` (`sniffFontType()` in `src/lib/fonts.ts`) —
  never from its name or the type the browser claims. A magic number, not a parse: a file that opens
  right and is broken after is the household's to fix, and a browser that can't use it falls back to
  Eczar. A collection (`ttcf`) is refused. **1 KB to 2 MB** (`FONT_MIN_BYTES`, `FONT_MAX_BYTES`):
  parsing a multipart body is CPU in proportion to its size (#73 measured 4 MB at about 4 ms), so a
  request that declares more is refused unread (413), and a file past the cap after parsing is too.
  Refusals land back on Members with the reason (`role="alert"`, the field marked invalid): 400 for a
  language that isn't shipped, no file, or bytes that aren't a font. Stored as uploaded — no
  subsetting, no conversion (10 ms CPU, §12).
- **Storage.** `src/lib/fonts.ts` is the R2 code for fonts, beside `src/lib/covers.ts`, and they are
  the only code that touches R2. Fonts share the covers bucket — no new resource, nothing for a
  deployment to create — each under its own `crypto.randomUUID()`, stored with its format's type
  (`font/woff2`, `font/woff`, `font/ttf`, `font/otf`). `/fonts/` serves only an object stored as a
  font, and `/covers/` never serves one.
- **Public by design.** `GET /fonts/:key` sits before the session middleware beside `/covers/:key`:
  the login page and share pages set their titles in the font too, so it must load signed out. Its
  key is random, never derived from anything, and a font file carries nothing about the household —
  no name, no item, no member. It is served with its own type, `Cache-Control: public,
  max-age=31536000, immutable` (a new upload mints a new key), `X-Content-Type-Options: nosniff`
  and a sandboxing CSP; no CORS header, since the pages that load it are on the same origin. A key
  not shaped like a UUID is never looked up.
- **The licence is the household's.** The upload form says so, and that the file becomes public like
  a cover: anyone with its address can download it. Nalanda ships no such font, and THIRD-PARTY.md
  lists nothing for it.
- **The R2 ordering.** R2 isn't in the D1 batch, so the order of the two writes decides what a failure
  leaves. **Upload: the object first, then the row**, so a page never names a key whose object isn't
  there; replacing, the old object is deleted only after the row names the new key. **Remove: the
  row first, then the object**, so no page is pointed at a font already gone. Either way a failure
  between the two leaves an orphaned object no row names — public bytes nobody loads, a few hundred
  KB of storage, never a broken page; and if the row's write itself fails after the object is
  stored, the object is deleted again. A share page cached on another isolate (#19) may name a
  replaced or removed font for up to an hour; its titles fall back to Eczar meanwhile.
- **Applying it costs no D1 call.** The resolved locale's font row is a fourth statement in the batch
  each page already makes for its language (#93): `sessionAccount()` for signed-in pages,
  `householdLocale()` for the login and setup pages, `shareWithLocale()` for share pages; Members
  reads the list in `membersSettings()`. It rides on the request's `Translator` (`font`), so the
  layouts read it with `useI18n()`. A signed-in page takes the font of the locale the member
  resolves to; the login page and share pages the household's — never a member's.
- **What the page gets.** Only when the resolved locale has a font, the head carries — after
  `app.css`, so it wins — a `<style>` with `@font-face { font-family: 'Household'; src:
  url('/fonts/<key>') format('<format>'); font-weight: 100 900; font-display: swap; }` and `:root {
  --serif: 'Household', <the shipped stack>; }`. The format hint is CSS's name for it (`truetype`,
  `opentype` for `.ttf` and `.otf` — a hint browsers don't know would make them skip the source).
  The face is declared across every weight, so a single-weight file is drawn as it is rather than
  thickened into a faux bold for a 600 title. The shipped stack is `SERIF_STACK` in
  `src/views/layout.tsx`, kept equal to `--serif` in `app.css` (a test holds them equal), so a
  letter the household's face lacks falls through to Eczar and Tiro Tamil as before. **Nothing else
  from the row reaches a page**: the key only after a `^[0-9a-f-]{36}$` check, the format only from
  its fixed list (`displayFaceOf()`); a row written by hand with anything else sets no face.
- **Backups** list `display_fonts` (after `translations`; no references), and the restore loop
  follows. The files are in R2 and, unlike covers, nothing can fetch them again: the runbook says to
  keep the files uploaded, and how to clear the rows if the bucket is lost.

**What it rules out:** a font per member (the face is the household's, like its translation; a
member's choice of language picks among the household's fonts); fonts for body text or data (the
sans and monospace stacks are the ledger's voice — the household's face takes only what `--serif`
takes: titles and the brand); a font picker from a CDN or a font service (nothing is fetched from
elsewhere — the shipped faces are vendored for the same reason, #93; the household's file is served
from its own bucket); subsetting or converting on the
server (10 ms CPU); a font for a language with no shipped interface (it would never be the resolved
locale).

Touches §9 (a public route whose bytes say nothing about the household), §10 (`GET /fonts/:key`,
`POST /settings/display-fonts`), §11 (`src/lib/fonts.ts`), §12 (the upload's size cap), §13 (a second
kind of object in the bucket, the only R2 code now two files), §16 #93 (the batches that bring the
language bring the font). Tests: `test/display-font.spec.ts` — the sniffer on each format and on an
image, a page and garbage; the name's cleaning; the key and format checks; the served headers, and
neither route serving the other's objects; the upload's refusals (member 403, a language that isn't
shipped 400, 1.5 KB of garbage 400, 3 MB 413) with nothing stored; a valid upload under a UUID key,
listed on Members; replace and Remove (row gone, object gone, style gone); the `<style>` only for
the locale that has a font and only its key, on the app, the login page and share pages; a
tampered row setting nothing; and the Overview, Account, a share page, the login page and Members
making the calls they made without one.
