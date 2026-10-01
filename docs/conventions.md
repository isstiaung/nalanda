# Working conventions

The working conventions in full. [CLAUDE.md](../CLAUDE.md) keeps each one in short form, every "never"
included; this file has the whole rule, the functions that carry it and the ARCH.md §16 decision behind
it. The styling, test and D1-budget notes here are the long form of CLAUDE.md's Stack and Hard
constraints bullets.

## Commits and releases

- **Commit after every completed feature or architectural unit** — conventional messages
  (`feat:`, `fix:`, `docs:`, `chore:`, `test:`); never batch unrelated changes into one
  commit. Push only when asked.
- **Releases** (ARCH.md §16 #42) are SemVer. A release commit bumps the version with
  `npm version X.Y.Z --no-git-tag-version`, updates `src/version.ts` to match (a test checks),
  renames `changelog/unreleased.md` to `changelog/vX.Y.Z.md` with its heading
  (`## [X.Y.Z] - <date>`) and a one-sentence summary, creates a fresh `changelog/unreleased.md`,
  and adds the version's line to the CHANGELOG.md index. Its **Upgrading** block says:
  migrations and whether to back up, new secrets, compatibility with connections on older
  versions. PRs add their entries to `changelog/unreleased.md`. After it merges, tag main
  `vX.Y.Z`; the release workflow publishes `changelog/vX.Y.Z.md` (only for tags on main; v1.0.0,
  which predates the workflow, was published by hand). A migration that changes data, a new
  secret, or anything needing a manual step must be in Upgrading.

## Requests, rendering and accessibility

- Handlers render a full page normally, a partial when the `HX-Request` header is present —
  one handler, two renders.
- Accessibility (ARCH.md §18): WCAG 2.2 AA in both themes. `hx-*` only on forms, buttons and links,
  every field labelled, errors `role="alert"` (+ `invalid()` on their fields), colour never the only
  signal; a new page or htmx swap joins `scripts/a11y.mjs`, and `npm run lint` + `npm run a11y` pass.
- Mutations are POSTs; CSRF = `SameSite=Lax` session cookie + Origin-check middleware.
- **Today is the device's day** (ARCH.md §16 #69). The Worker's clock is UTC; `public/app.js` writes the
  browser's IANA zone into a `tz` cookie, and `todayOf(c)` (src/views/layout.tsx) reads it, falling back to
  UTC for a missing or unknown zone. Every date a page offers (Finish, Played, Start) or a handler fills in
  when none is given (a first page's read, a loan, a return) comes from it: a route never takes a day from
  `new Date()` or lets SQL default one with `date('now')`. `todayUtc()` is for tests and for the bound on
  how late a date may be (`latestReadDate()`, tomorrow in UTC, at or after today anywhere). Stored
  timestamps are still shown as their UTC date.

## Writes, accounts and permissions

- Deleting an item is `trashItems()` (ARCH.md §16 #74), never a bare `DELETE FROM items`: the
  snapshot and the delete are one batch, and the cover's object stays until the trash row is
  purged. Restoring is `restoreFromTrash()`, an import of the snapshot. Never add a soft-delete
  column to items: 88 reads would have to honour it, and one miss is a leak.

- A write and whatever depends on it are **one batch**: a change and the message it queues for a
  connection, the notification it records, its replay marker, an item and its tags (ARCH.md §16 #39).
  As separate calls, a failure between them leaves half a change that the path's own idempotency
  check then treats as done. Nothing after the batch may be able to fail the request.
  Cookies set `Secure` only on https so local dev login works.
- Auth model (ARCH.md §8): admin creates member accounts with one-time temp passwords
  (`must_change_password`); roles are just `admin`/`member` — no permission matrix.
  User ids are reused (no AUTOINCREMENT), so a session names the id **and** `users.session_key`
  (random, set in the insert, never changed — ARCH.md §16 #56). Every path that
  inserts a user sets a key; anything else that remembers a person across time (an HMAC
  stamp, a cache) binds `accountIdentity()`, never the bare id. Which of an account's sessions
  still count is `users.session_generation` (ARCH.md §16 #70): the cookie names the generation it
  was made in (`g`, absent for 0), the middleware compares it with the row it already reads, and
  "Sign out other devices" (Account), a password change and an admin's reset each add one in the
  statement that writes — the device acting re-issues its own cookie with `signIn()` from the row
  returned. The key is never rotated for this: the identity stamps hang from it.
- Members change their own reads, pages and review; admins anyone's, and only admins move
  one to another member. Check it in the route (403 with a reason) *and* in the statement
  that writes (the `Actor` guards in `src/db/queries.ts`). No permission matrix beyond this.

## Migrations

- Never hand-edit drizzle-generated migrations; hand-written SQL goes in `--custom`
  migrations. Migrations are append-only — never edit one that has been applied anywhere.
- The FTS5 index and its three sync triggers (`items_fts_ai`/`_ad`/`_au`) are custom migrations —
  0001, 0032, 0045, 0054 — since Drizzle's DSL can't express them. The update trigger lists the
  six indexed columns (`AFTER UPDATE OF …`): an update that touches none of them writes no index
  rows (test/fts-sync.spec.ts). A column added to the index means a new custom migration that
  recreates the table, all three triggers with the new column, and a `'rebuild'`.
- The snapshot chain in `migrations/meta/` has a known gap at 0028: `0028_snapshot.json` was never
  committed, and `0029_snapshot.json`'s `prevId` names it. It is harmless — `drizzle-kit generate`
  diffs the schema against the newest snapshot only, which is current — and it stays as it is:
  don't "repair" it by renumbering or regenerating, which would touch applied migrations.

## Catalogue data

- Barcode routing lives in `src/metadata/index.ts`: EAN-13 starting `978`/`979` → book
  providers (Open Library + Google Books merged); an ISBN-10 — nine digits and a check digit,
  which can be `X` — the same, recorded as `isbn10Upc` beside the ISBN-13 it stands for (Google
  Books' when it names one, else `isbn13Of()` derives it), so a later EAN-13 scan of the book
  is "In your catalog"; any other EAN/UPC → Discogs.
- Tags are normalized lowercase at write time; uniqueness is by exact string.
- `copies = 0` = "in the catalog, not in the physical collection" (reading-log entries,
  e.g. Goodreads imports). Not lendable; badged "Not owned" everywhere incl. share pages
  (ARCH.md §16 #13). The Holding toggle spans **only 0 and 1** — an item held in 2+ copies
  renders a plain count, and the route refuses to zero it, because `copies` round-trips
  through `/export.csv` (ARCH.md §16 #27).

## Reading and reviews

- Reading state lives in `reads`, one row per read (ARCH.md §16 #41), each with its reader
  (`reader_id`; NULL = a member removed since — §16 #43). `items.status`, `began_on`,
  `completed_on`, `read_count`, `rereading` and `progress_page` are the **household's** summary
  of everyone's reads: write reads and `refreshReadState()` in one batch, never those columns
  directly. Completed once anyone has finished it; a re-read — or anyone's read of a book
  someone finished — keeps it Completed (`rereading` marks it). Every Status filter — the shelf,
  share links, connection views — lists a re-read under In progress **and** Completed
  (`matchesStatus()` in src/lib/reads.ts, `statusWhere()` its SQL twin, ARCH.md §16 #64; never
  compare `items.status` to a filter by hand), and its status pill says "Re-reading". Each
  person has at most one open read of an item; "Read again", Finish, Stop and Record act on the
  signed-in person's own reads, and the edit form's status
  and dates are theirs. Pages belong to their read's reader (`reading_progress.added_by`
  follows a moved read). A finished book takes no page from you until you "Read again".
- Ratings and reviews live in `reviews`, one per member per item (§16 #43). `items.rating`
  (the average, rounded to 1–10) and `items.review` (the one written last, by `reviewed_at`)
  are their summary: write reviews and `refreshReviewState()` in one batch, never those
  columns directly. `reviewed_at` moves only when the text really changes, so a rating
  changed alone never makes an old review the household's latest; a write that can remove a
  review also carries `redateReviewActivity()`, so an older review showing again isn't news.
  Only an admin's import keeps the names a file gives reads and reviews; a member's is theirs.

## Styling

- Styling is the hand-written design system in `public/app.css` — no CSS framework. The
  visual identity is "the manuscript ledger" (ARCH.md §16 #16), grounded in Nalanda's
  Pala-era scriptorium: palm-leaf buff paper, lampblack ink, indigo working accent,
  vermilion rubrication reserved for circulation/danger, turmeric gold for ratings,
  monospace for all data (counts, ISBNs, dates, pills, accession numbers via `accNo()`),
  Eczar (vendored woff2, Devanagari-first face) for page titles and brand only, light +
  dark (lamp-lit) via `prefers-color-scheme`. The brand hangs from its vermilion
  headstroke (śirorekhā) — that rule lives in `.brand-rule` only. Extend with the
  existing tokens/components (`.pill`, `.data-table`, `.props`, `.eyebrow`) — don't add
  frameworks.

## Tests

- Tests: Vitest + `@cloudflare/vitest-pool-workers` (runs in real workerd). Since v0.20
  there is no automatic per-test isolated storage: `test/apply-migrations.ts` calls
  `reset()` and re-applies migrations before every test, and outbound `fetch` is stubbed
  by `test/fetch-mock.ts` rather than the removed `fetchMock` (ARCH.md §16 #25). Config is
  a plain Vitest config plus the `cloudflareTest()` plugin — `defineWorkersConfig` is gone.

## The D1 call budget

- **D1 calls per Worker invocation — design to 50, the real cap is 1,000** (ARCH.md §16 #37).
  D1's limits page says 50 on the free plan, but measured on this account the runtime allowed
  exactly 1,000 D1 calls per invocation, and a `batch()` counted as **one** call however many
  statements it held. Work handed to `waitUntil` belongs to the page's invocation. Keep 50 as
  the budget — conservative, and possibly what binds elsewhere — but a batch is one call.
  Connections' background work (feed and outbox pulls, push retries) runs through the
  budgeted handle in `src/federation/budget.ts`; tests count queries per page load with it.
