# Runbook: Troubleshooting

## Watching logs

```sh
npx wrangler tail        # live production logs (errors from onError land here)
```

Local dev prints to the `npm run dev` terminal.

## Scanner

| Symptom | Cause / fix |
|---|---|
| Camera never opens | Camera needs HTTPS (workers.dev is fine) or localhost. Plain-http LAN IPs won't work — use the deployed URL on phones. |
| Opens but never detects | iOS/Firefox use the WASM fallback — the first scan downloads ~1 MB once; wait for "Loading barcode decoder…" to clear. Glossy sleeves: more light, less angle. |
| Detects but "no book found" | Open Library gaps happen. Try the Search tab, or set `GOOGLE_BOOKS_KEY`. Manual entry always works. |
| Vinyl barcode → token notice | Set the `DISCOGS_TOKEN` secret ([deploy.md](deploy.md) → API tokens). |
| No camera at all | Type the digits into the field under the scanner — same lookup. |
| "No signal" page while online | The installed app shows its offline page when your server doesn't answer a page at all (Worker down, DNS, captive Wi-Fi). Open the address in the browser to see the real error. Scans made meanwhile are held and listed on **Add items** once pages load again. |
| Offline page says nobody is signed in | Scans are held only for the account signed in on the phone, and logging out clears them. Sign in once with signal, then scan. |
| Held scans vanished | Someone else signed in on the phone (the queue belongs to one account at a time), or that account logged out. Scans aren't sent anywhere until reviewed, so there's nothing to recover. |
| Phone still shows an old icon or files | The browser checks `/sw.js` on each visit and swaps in a new version at once; a home-screen icon updates when the browser next reads the manifest. Removing and re-adding the app is the quick way. |

## Lookups

- **Board game search asks for `BGG_TOKEN`, or says BoardGameGeek rejected it**: BGG needs a
  registered application's token for every request since 2025 — see [deploy.md](deploy.md) →
  API tokens. A token that worked and now doesn't was likely revoked; issue a new one.
- **"BoardGameGeek is busy"**: BGG throttles apps that ask too often (its docs suggest about
  5 seconds between requests). Wait a few seconds and search again. If it keeps saying so,
  check **Usage** by your application at <https://boardgamegeek.com/applications>.
- **"BoardGameGeek did not answer"**: BGG, or its Cloudflare edge, turned the request away or
  is down. Try again later. Manual entry always works.
- **"No board games found"**: BGG answered and nothing matched. Try BGG's own spelling, or
  fewer words.
- **Discogs 401 in logs**, or **"Discogs refused the DISCOGS_TOKEN"** after Refresh from
  Discogs: token revoked or mistyped — re-run `npx wrangler secret put DISCOGS_TOKEN`.
- **"Discogs is busy"** after Refresh from Discogs: Discogs allows 60 requests a minute per
  token, and each click is one. Wait a minute and click again.
- **Refresh from Discogs doesn't change a field**: it only fills blanks, never replaces a value
  (ARCH.md §16 #55). To take Discogs' value instead — say a record added before pressing
  details kept the short format a search gave it — clear that key in the edit form's details
  JSON, save, and refresh. **"Found by barcode — refresh again for the tracklist"**: a barcode search has no
  tracklist; the release id it stored fetches one on the next click.
- **"Something went wrong — try again."** after Refresh from Discogs or Refresh from BGG (above
  the button), or after any other in-place button — Played, Finish, the Holding toggle, Another —
  (at the bottom of the page): the server answered with an error. Look in `wrangler tail` for the
  request, then reload the page and click again. Discogs' and BGG's own refusals say so in their
  own words instead. The message at the bottom of the page is always one of a few fixed
  sentences, never the server's own text (ARCH.md §16 #65):
  - **"Couldn't reach Nalanda — check your connection and try again."** — no answer at all: the
    phone or laptop is offline, or the Worker is unreachable. Nothing was saved.
  - **"That's no longer here — reload the page."** — a 404: the item, read or play was deleted,
    perhaps from another device.
  - **"You can't do that here."** — a 403 from a route: an admin-only action, or someone else's
    read or review. The page doesn't offer those, so a role changed since the page loaded.
  - **"Nalanda couldn't tell that came from this page — reload it and try again."** — the CSRF
    check refused the request: the browser didn't send `Sec-Fetch-Site: same-origin`, or sent an
    `Origin` other than the Worker's own (a proxy rewriting the host, an extension).
  - **"That didn't go through — reload the page and try again."** — any other refusal (a 400 or
    409): the page is out of date with what's saved.
- **A click lands on the login page**: the session expired (30 days), the member was removed, or
  the Worker's `SESSION_SECRET` changed. Sign in again; nothing was done. A member who still has to
  choose a password lands on Account instead.
- **Weird edition data** (wrong publisher/year): providers return their "best" edition.
  Edit the item after saving — lookup fills the form, it doesn't own the data.
- **Backfill stops with "request failed (500)"**: a large backfill can trip the free plan's
  per-request limits. Click again to resume. For hundreds of items, run it from your machine
  instead: [metadata-backfill.md](metadata-backfill.md).
- **Backfill finds descriptions but almost no covers**: Google Books is probably out of quota
  (1,000 requests a day, reset at midnight US Pacific time). It supplies most covers, so wait for
  the reset and run it again.

## Deploys & database

- **`D1_DATABASE_ID is not set`** during a Cloudflare build, while the dashboard clearly
  shows it set: it's under **runtime** secrets rather than **Build** settings. Runtime
  secrets are bound into the Worker at request time and are invisible to the build
  container. Move it to the Worker's Build variables/secrets. Deploying by hand instead:
  `D1_DATABASE_ID=$(npx wrangler d1 list | grep nalanda) npm run deploy`, or just
  `D1_DATABASE_ID=<id> npm run deploy`.
- **`D1 binding 'DB' references database '00000000-0000-0000-0000-000000000000'`**: the
  build ran a bare `wrangler deploy` instead of `npm run deploy`, so the placeholder in
  `wrangler.jsonc` was never substituted and remote migrations never ran. Set the Worker's
  **deploy command** to `npm run deploy` (Cloudflare's default is the bare form).
- **`Invalid uuid` from the D1 API on deploy**: `D1_DATABASE_ID` holds something that
  isn't the database id — check `npx wrangler d1 list`.
- **"migrations pending" or schema mismatch locally**: `npm run db:migrate` (local) /
  `npm run db:migrate:remote` (production; `npm run deploy` does this automatically).
- **Local dev acting haunted**: nuke local state — `rm -rf .wrangler/state && npm run
  db:migrate`.
- **Login loops locally**: cookies are `Secure` only on https, so http://localhost works
  by design. If you proxied dev behind something odd, don't.

## Free-tier limits

- **Worker CPU (10 ms)**: the app is designed under it (CSV parsing in browser, CSV export a
  page at a time, no image processing, native crypto). If you somehow hit `exceeded CPU` in `wrangler tail`,
  Workers Paid ($5/mo) raises it to 30 s with zero code change — but investigate first;
  it's probably a bug, not a limit.
- **"Export failed partway, so nothing was saved"**: one page of the export didn't come back
  as CSV — a server error (look in `wrangler tail`), a dropped connection, or a session that
  expired mid-export. Nothing partial is saved, so just press Export again (after logging in
  again, if that was it). The plain `/export.csv` link, as used without JavaScript, builds the
  whole file in one request, and on a large catalog it can run past the CPU limit and fail.
- **Request/read quotas**: 100k requests/day, 5M D1 row-reads/day. A household cannot
  realistically hit these; check the Cloudflare dashboard graphs if curious.

## First-run

- **Setup or login says `SESSION_SECRET` isn't set** ("Not ready yet"): the Worker has no
  session secret, or it's empty or only whitespace. Set one with
  `npx wrangler secret put SESSION_SECRET` (value: `openssl rand -base64 32`), or in the
  dashboard under the Worker → Settings → Variables and Secrets. It applies without a
  deploy; reload the page. If setup said nothing was saved, create the admin account at
  `/setup` again. If it says an account already exists, log in with it: versions before
  1.3.0 created the account before failing. Locally, put it in `.dev.vars` and restart
  `npm run dev`.
- `/setup` 404s → an account already exists. Log in instead, or for a true factory reset
  see the admin-lockout section in [accounts-and-access.md](accounts-and-access.md).
- Forgot the URL → `npx wrangler deployments list` shows it, or the dashboard.
