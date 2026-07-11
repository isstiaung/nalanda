# Runbook: Deploy

## First deploy (once)

1. **Create the cloud resources** (free tier):
   ```sh
   npx wrangler d1 create nalanda
   npx wrangler r2 bucket create nalanda-covers
   ```
   Copy the `database_id` that the first command prints into `wrangler.jsonc`, replacing
   the `00000000-…` placeholder. The bucket needs no config change.

2. **Set secrets** (each command prompts for the value):
   ```sh
   npx wrangler secret put SESSION_SECRET   # generate one: openssl rand -base64 32
   npx wrangler secret put DISCOGS_TOKEN    # see "API tokens" below — enables vinyl lookup
   npx wrangler secret put GOOGLE_BOOKS_KEY # optional, raises book-lookup quota
   ```

3. **Deploy**:
   ```sh
   npm run deploy
   ```
   This applies remote D1 migrations first, then deploys the Worker and prints your
   `https://nalanda.<account>.workers.dev` URL.

4. **Create your account**: open `<your-url>/setup` immediately — it creates the admin
   account and disables itself once a user exists.

## Every subsequent deploy

```sh
npm test && npm run deploy
```

Migrations are append-only and applied automatically before the Worker code goes live.

## Taking your local data to production

Been cataloging against local dev? Your catalog is a real SQLite database under
`.wrangler/state/` and comes with you. (This procedure is rehearsed: rows and the search
index restore cleanly; covers are re-fetched.)

1. Do **First deploy** steps 1–2 (create resources, set secrets), then apply the schema:
   ```sh
   npx wrangler d1 migrations apply nalanda --remote
   ```
2. Export local data and load it into production (FK-safe order):
   ```sh
   npm run backup:local
   for t in users libraries items tags item_tags loans; do
     npx wrangler d1 execute nalanda --remote --file=backups/local-<date>/$t.sql
   done
   ```
3. `npm run deploy`, then log in at the production URL — same username and password.
4. **Covers**: the image files live in local R2 emulation and don't transfer. Clear the
   stale references and re-fetch once:
   ```sh
   npx wrangler d1 execute nalanda --remote --command "UPDATE items SET cover_key = NULL"
   ```
   then production `/import` → **Cover backfill** (a few minutes).
5. From here, treat production as the source of truth. Local dev keeps its own separate
   copy — reset it whenever with `rm -rf .wrangler/state && npm run db:migrate`.

## Go-live checklist

- [ ] `npx wrangler d1 create nalanda` → paste the `database_id` into `wrangler.jsonc`
- [ ] `npx wrangler r2 bucket create nalanda-covers`
- [ ] `npx wrangler secret put SESSION_SECRET` (`openssl rand -base64 32`)
- [ ] `npx wrangler secret put DISCOGS_TOKEN` (vinyl lookups)
- [ ] optional: `npx wrangler secret put GOOGLE_BOOKS_KEY`
- [ ] data: migrate the local catalog (section above) — or start fresh via `/setup`
- [ ] `npm test && npm run deploy`
- [ ] smoke: log in, scan one barcode, open a share link in a private window
- [ ] if migrated: run **Cover backfill** on production
- [ ] first production backup: `npm run backup`
- [ ] add family members (Members page)
- [ ] later, optional: custom domain · Cloudflare Access in front

## Rollback

- **Code**: `npx wrangler rollback` reverts the Worker to the previous deployment.
- **Schema/data**: code rollback does NOT undo migrations. If a migration caused the
  problem, restore the database instead — see
  [backup-and-restore.md](backup-and-restore.md).

## API tokens

- **Discogs** (vinyl barcode + name lookup): create a free account at discogs.com →
  Settings → Developers → *Generate new token* (a "personal access token"). Set it as the
  `DISCOGS_TOKEN` secret. Without it, vinyl lookups show a notice and manual entry still
  works.
- **Google Books** (optional): console.cloud.google.com → create a project → enable
  *Books API* → Credentials → API key. Books work keyless; the key only raises the quota.
- **Open Library / BoardGameGeek**: no keys, nothing to do.

For local development, put the same values in `.dev.vars` (never committed).

## Custom domain (whenever you want one)

Cloudflare dashboard → Workers & Pages → `nalanda` → Settings → Domains & Routes →
*Add* → Custom domain. TLS is automatic and free. No code or config change needed; the
share links and cookies key off the request host.

## Sanity checks after a deploy

```sh
npx wrangler tail            # live logs while you click around
```

Log in, scan one barcode, open a share link in a private window. Done.
