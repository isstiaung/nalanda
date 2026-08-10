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

## Lookups

- **BGG empty results / slow**: BoardGameGeek throttles anonymously — wait a few seconds
  and retry; the search tolerates it. Persistent failures usually mean BGG itself is down.
- **Discogs 401 in logs**: token revoked or mistyped — re-run
  `npx wrangler secret put DISCOGS_TOKEN`.
- **Weird edition data** (wrong publisher/year): providers return their "best" edition.
  Edit the item after saving — lookup fills the form, it doesn't own the data.

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

- **Worker CPU (10 ms)**: the app is designed under it (CSV parsing in browser, no image
  processing, native crypto). If you somehow hit `exceeded CPU` in `wrangler tail`,
  Workers Paid ($5/mo) raises it to 30 s with zero code change — but investigate first;
  it's probably a bug, not a limit.
- **Request/read quotas**: 100k requests/day, 5M D1 row-reads/day. A household cannot
  realistically hit these; check the Cloudflare dashboard graphs if curious.

## First-run

- `/setup` 404s → an account already exists. Log in instead, or for a true factory reset
  see the admin-lockout section in [accounts-and-access.md](accounts-and-access.md).
- Forgot the URL → `npx wrangler deployments list` shows it, or the dashboard.
