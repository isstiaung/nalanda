# §16 #65 — htmx failures are shown app-wide; an expired session redirects the whole page

**Decided:** 2026-09-30 (when an htmx request fails, or the session has lapsed). Cited as `ARCH.md §16 #65`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Two gaps found while building #55's in-place refresh, both app-wide:
- **A failed htmx request said nothing.** With no `responseHandling` config, htmx 2 swaps a 2xx
  and nothing else, and fires `htmx:responseError` (4xx, 5xx), `htmx:sendError` (no answer) or
  `htmx:timeout`. Nothing listened, so Played, Finish, Stop, a page, the Holding toggle, Want,
  purchase links, Another and every other htmx control silently did nothing on a 500, and on a
  dropped connection — which the installed app (#48) meets on a phone. Now the layout renders
  one `<output id="app-status" aria-live="polite">` after `<main>` on every signed-in page (not
  on login or setup, never on share pages, which don't load app.js), and a handler in
  public/app.js fills it with a fixed sentence by kind:
  no answer or a timeout → "Couldn’t reach Nalanda — check your connection and try again.";
  5xx → "Something went wrong — try again."; the CSRF check's 403 → "Nalanda couldn’t tell that
  came from this page — reload it and try again."; any other 403 → "You can’t do that here.";
  404 or 410 → "That’s no longer here — reload the page."; any other 4xx → "That didn’t go
  through — reload the page and try again." It reads the status and one header, never the
  answer's body or the URL, so nothing a server, a proxy or a stranger's string put there
  reaches the page. The CSRF middleware marks its own refusal of an htmx request with
  `X-Nalanda-Refused: origin` — a key choosing a sentence, never shown — because its refusal
  isn't the person lacking a right, and "You can't do that here" would say it was.
  Routes' own 403 reasons ("That play was logged by someone else…") are fixed and meant for
  people, but reading them means showing a body, and only a hand-made request or a role
  changed mid-session reaches one (the page never offers what's refused): the generic sentence
  stands in. No htmx route relies on a 4xx body being swapped: the convention (Where to buy, #53; the Reading
  section) is that a refusal the section must show answers 200 with the section and its `role="alert"` error
  (Where to buy, the Reading section's bad page or dates), so `responseHandling` stays htmx's
  default. The 400s and 409s that remain on htmx paths are either a hand-made request's
  (progress on a record, plays on a book) or the Add page's review list's, which uses its own
  `fetch` and shows the text itself — htmx never sees those.
  **Scoped handlers win.** A control with its own status says its failure there and calls
  `preventDefault()` on the event: #55's `data-refresh-status` forms, and the scanner's lookup
  whose `sendError` holds the barcode offline and says so. The page-wide handler listens on
  the `window`, after every handler on the document, and leaves a prevented event alone: one
  message, never two.
  **The region.** Sticky at the bottom of the view, in the content column's gutters (16px on
  a phone), rubricated like a refused form's error on an opaque ground, empty and drawing
  nothing until needed. Its slot is in the flow after `<main>`, so scrolled to the end it
  covers nothing; mid-page it passes over the bottom edge while it shows. It empties on the
  next htmx request that succeeds; the same sentence again is emptied and said again, so a
  screen reader hears it. No dismiss button: a button inside a status region is read out
  with every message, and the layout adds one element. No timer: a message that vanishes on
  its own fails people who read slowly.
  **Nothing stuck.** htmx itself re-enables `hx-disabled-elt` and drops `htmx-request` on
  every failure. The button pressed gets focus back when the browser dropped it to `<body>`
  (disabled while waiting) or to `<main>` (a second click on it then) — Played lost focus that
  way before this.
- **An expired session swapped the login page into the section.** `requireAuth` answered with
  a 302; htmx follows redirects inside its XHR, got the login page with a 200 and swapped it —
  a second `<main>`, a changed tab title, and for #55's Refresh "Asking Discogs…" left
  standing, since a 200 is no error. Now `sendTo()` in src/index.ts answers a request carrying
  `HX-Request` with `HX-Redirect` — htmx loads that URL as the page — and a non-2xx status,
  so a script's own `fetch` with the header (the Add page's review list) sees a refusal, with
  a sentence for it as the body. Every redirect the session middleware makes: no session, an
  expired or forged cookie, a session key that no longer matches (§16 #56: a removed member,
  a reused id) → `/login`, 401, "Signed out — reload and sign in."; no users yet → `/setup`,
  401; `must_change_password` → `/account`, 403, "Choose a new password first — reload the
  page." The HOME_SHARE_TOKEN front door (#21) steps aside for htmx: Read next's Another
  after the session lapsed is someone in the app, and goes to log in, not to the share.
  A browser's own navigation keeps exactly the 302s it had. `/share/*`, covers, login and
  setup, and federation's signed endpoints sit before the session middleware and are
  untouched. There is no return address: login has never taken a `next` parameter, and
  adding one would need an open-redirect guard — it lands on the Overview, as before.
  htmx keeps the pressed control disabled while the browser follows an `HX-Redirect`, so
  app.js loads the page again if the browser brings it back from its page cache after one.
- **Tests.** test/htmx-errors.spec.ts: htmx GETs and POSTs with no session, an expired cookie,
  a rotated key, a removed member, a fresh instance and `must_change_password` get
  `HX-Redirect` and no Location, and the same requests without htmx their 302s; the CSRF
  mark only on htmx's refusal; the region once per signed-in page and never in a partial, on
  login or on a share page (whose HTML was compared byte for byte with the base); app.js's
  handler reading no body. `npm run a11y` fails Another with a 500 in the browser and audits
  the page with the message showing, both themes, both widths.

**Chosen without asking, overrulable:** the generic 403 sentence rather than a route's
reason; the CSRF refusal's own sentence (via a response header); no dismiss button; the
sticky bottom placement; 401/403 rather than 200 alongside `HX-Redirect`; no `next` parameter;
curly apostrophes in the sentences, as the app's other strings have.
