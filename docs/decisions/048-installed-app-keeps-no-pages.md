# §16 #48 — The installed app keeps no pages; offline scans are barcodes held on the device, for the account signed in there

**Decided:** 2026-09-30 (an app on the phone, and scanning with no signal). Cited as `ARCH.md §16 #48`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Nalanda installs to a home screen (manifest with id, scope, a Scan
shortcut, paper as theme and background; 192/512 tiles with see-through corners, a full-bleed
maskable 512 — the tiled master's tower at 0.8 scale, centred, inside the 40% safe zone — and
the 180 apple-touch-icon; iOS home-screen metas). The owner's three decisions: installable;
the scanner works with no signal, holding barcodes in IndexedDB until the Add page's review
list, where each is added to a chosen shelf or dropped (or "add all to <shelf>"), and nothing is
added unseen; and **no authenticated HTML or API answer is ever cached on the phone** (shared
devices).

*The service worker* (`public/sw.js`, served from the root as a static file, so its scope is
`/`) keeps one versioned cache, `nalanda-static-v<VERSION>`, of the files in `STATIC`: the
offline page, app.css, the favicon, the Eczar fonts, scan-queue.js, scanner.js and the ZXing
reader with its wasm — nothing about anyone. Navigations go to the network and are never
stored; only a failed one gets `/offline.html`. A listed file is network-first (refreshing
its copy, used only when the network fails), so a deploy reaches phones at once and nobody is
stranded on old assets; install fetches past the HTTP cache without credentials and refuses
anything but a 200 that wasn't redirected; activation deletes every older `nalanda-` cache;
`skipWaiting` + `clients.claim`, and app.js registers with `updateViaCache: 'none'`. Every
other request — `/share/*` (never answered, even offline: its behaviour is unchanged), API
calls, htmx partials, covers, other origins, every POST — gets no `respondWith` at all.
Registered from app pages and the login page only; share pages never register it. Nothing
but a failed navigation asks for the offline page, so a successful page load refreshes its
copy (at most hourly, without a cookie) — otherwise an edit to it would wait for a version bump.

*Why a static offline page rather than caching `/add`:* the Add page is a signed-in page
(shelves, the sidebar's names), so keeping it would break the rule. `offline.html` is a
static file with the scanner and nothing else; it stands in for any page the network can't
reach. The Add page already open when the signal goes keeps scanning too: a barcode found
while `navigator.onLine` is false, or whose lookup never reached the server (`htmx:sendError`
on `/add/results`), is held instead. Offline, the camera stays on for the next barcode.

*The queue* (`scan-queue.js`): IndexedDB `nalanda-scans`, one row per barcode —
`{ barcode, scannedAt }` and nothing else — at most 200, a repeat kept once. The review list
(`scan-review.js`) looks each one up through `GET /add/review?barcode=&scanned=` — the lookup
behind `/api/lookup`, one barcode a request, two at a time, so each stays in one request's
subrequest and CPU budget — which renders the entry server-side (`ReviewEntry`), testable in
workerd, rather than building cards from `/api/lookup`'s JSON in the browser. Adding posts
the entry's form to `POST /items` with `HX-Request`, which answers htmx with the added entry
(one handler, two renders); a row leaves the queue only after that 200. Want does the same
with `want=1`, as a search result's does (§16 #53): onto the adder's want list, as Not owned
or on the copy the catalog already has — answered with the entry too, never a redirect, and
refused like Add when `scanOwner` isn't the signed-in account's. Drop is the device's
alone: it deletes the row, and no server route exists for it.

*Whose queue:* the device's and the signed-in account's. Every signed-in page carries an
opaque stamp, `scanQueueOwner()` = HMAC(`SESSION_SECRET`, `scan-queue:<id>:<session key>`),
16 bytes — the account's identity, not its reusable id (#56); app.js
keeps it in localStorage and, **when a different stamp appears, deletes the queue** before
anything reads it (it runs first, and IndexedDB serves a delete before a later open). **Logout
also deletes it** and forgets the stamp (bounded at 1.5 s so a stuck IndexedDB can't keep
anyone signed in). Chosen over logout-only because a session can end without a logout (expiry,
a cleared cookie) and the next person to sign in on a family phone would have seen the scans;
the stamp covers that, and logout covers a device nobody signs back into. With no stamp —
signed out — the offline page won't hold scans. scan-queue.js also compares the device's
stamp with the page's own and refuses to list, hold or remove on a mismatch, so a page whose
app.js failed to load still shows nothing of the previous account's. A review entry carries the stamp it was
rendered for (`scanOwner`), and `POST /items` refuses it with 409 for anyone else — a list
left open in one tab while someone else signs in in another adds nothing. The stamp says
nothing about the account, and its message has a colon, which a session payload (base64url)
never does, so no stamp is a valid session signature.

*Headers:* `secureHeaders()` sets no CSP and no Permissions-Policy, so the worker, the manifest,
the camera and IndexedDB need nothing; static files never pass through the Worker anyway.
Signed-in pages kept sending no Cache-Control, as before (amended below). `wrangler.jsonc` sets
`html_handling: "none"`: Cloudflare otherwise redirects `/offline.html` to `/offline`, which
the worker can't store as a navigation answer, and a missing `/offline` would reach the login
redirect; `MISSING_ASSET` now covers `.html`, so a missing one 404s.

*Tests:* vitest binds `public/` as `ASSETS` (tests only) to read the manifest, icons and sw.js
as served, and runs sw.js's own source against a stand-in `self`/`caches`/`fetch` —
install, activate, and a table of requests. What needs a browser (registration, going
offline, IndexedDB, the review list, logout) was checked with Playwright against a scratch
dev server.

**Chosen without asking, overrulable:** network-first for the listed files (no speed-up
online, in exchange for never serving an old one while the network works); a 200-scan cap;
re-rendering the 192/512 tiles, whose corners were white; a manifest shortcut to /add; the
offline page refuses to hold scans when nobody is signed in on the device; "add all" skips
entries with no match; `/offline.html` rather than `/offline`. The §14 non-goal "offline sync"
stands: nothing is synced — the phone holds barcodes until a person reviews them.

**Amended 2026-10-01 — the browser's own cache too.** This decision kept the service worker from
storing a page; the browser's HTTP cache and back-forward cache were left as they were, and on a
family phone A's logout followed by B's Back could show A's pages — notes, locations, borrowers,
a temporary password minted on the Members page. Every answer served behind the session middleware
now carries `Cache-Control: no-store` (set in `src/index.ts` after the handler runs, so a page, a
partial and a redirect all get it), and `POST /auth/logout` sends `Clear-Site-Data: "cache"` for
whatever a browser kept anyway. Share pages, covers, static files and the login page are served
before that middleware and cache as before — the share-page cache (§16 #19) is untouched. The
service worker's rule stands: it still never stores a page or an API answer, and `no-store` on a
page is the same rule stated to the browser. Tests: `test/browser-cache.spec.ts`.

**Amended 2026-10-01 — one mode, looked up on demand (#94).** The review list no longer looks every
held barcode up on page load (two at a time through `/add/review`): with "Keep scanning" holding
barcodes online as well, a list of two hundred would have cost two hundred lookups on every visit.
An entry now shows the barcode and its time, and is looked up only on **Look up** (the same
`/add/review` entry, with Add, Want and Drop as before) or by **Add all**, which posts the list to
`POST /api/scans/add` twenty a request. The queue, its shape, its owner stamp and `POST /items`'s
refusal are unchanged; "nothing is added unseen" is kept as a report that names every item added.
