# Runbook: Deploy

## First deploy (once)

1. **Create the cloud resources** (free tier):
   ```sh
   npx wrangler d1 create nalanda
   npx wrangler r2 bucket create nalanda-covers
   ```
   Note the `database_id` the first command prints — you supply it at deploy time as
   `D1_DATABASE_ID` rather than committing it. `wrangler.jsonc` keeps an all-zero
   placeholder there on purpose: the repo names no Cloudflare resource, and local dev,
   local migrations, and the tests all run happily against the placeholder. Leave it
   alone — editing it re-keys local storage, so a dev database you've been filling will
   suddenly look empty. `npx wrangler d1 list` shows the real id again later. The bucket
   needs no config change.

2. **Set secrets** (each command prompts for the value):
   ```sh
   npx wrangler secret put SESSION_SECRET   # generate one: openssl rand -base64 32
   npx wrangler secret put DISCOGS_TOKEN    # see "API tokens" below — enables vinyl lookup
   npx wrangler secret put BGG_TOKEN        # see "API tokens" below — enables board game search
   npx wrangler secret put GOOGLE_BOOKS_KEY # optional, raises book-lookup quota
   npx wrangler secret put HOME_SHARE_TOKEN # optional front door: logged-out "/" 302s to
                                            # /share/<value>. Setting a secret applies
                                            # immediately (no git push). If you rotate that
                                            # share, re-put the secret with the new token —
                                            # until then "/" degrades to the login page.
   ```

3. **Deploy**:
   ```sh
   D1_DATABASE_ID=<id from step 1> npm run deploy
   ```
   This resolves the id into a gitignored copy of the config, applies remote D1
   migrations, then deploys the Worker and prints your
   `https://nalanda.<account>.workers.dev` URL. Deploying without `D1_DATABASE_ID` stops
   with instructions rather than failing halfway.

   Export it in your shell profile if you deploy from a laptop often. If you deploy
   through Cloudflare's dashboard git integration instead, set `D1_DATABASE_ID` as a
   **build variable or build secret** on the Worker — a build without it fails at the
   first step.

   > **The trap:** it must live under the Worker's **Build** settings, *not* under runtime
   > secrets and *not* via `wrangler secret put`. Runtime secrets are bound into the Worker
   > at request time; the build container never sees them, so `npm run deploy` exits with
   > "D1_DATABASE_ID is not set" while the dashboard shows the secret plainly set. Also
   > confirm the **deploy command** is `npm run deploy` — Cloudflare's default is a bare
   > `wrangler deploy`, which skips the substitution and remote migrations entirely and
   > fails with `D1 binding 'DB' references database '00000000-…'`.

4. **Create your account**: open `<your-url>/setup` immediately — it creates the admin
   account and disables itself once a user exists. If it says `SESSION_SECRET` isn't set,
   step 2 didn't take: set it and reload. Nothing is saved until then.

## Every subsequent deploy

If the deploy carries a migration, back up first. A migration changes production data as it's
applied, and a code rollback doesn't undo it (see [Rollback](#rollback)). To see whether it
carries one, compare what you're about to deploy with what's live: the commit you last
deployed, or, with the git integration, the tip of the branch Cloudflare builds from.

```sh
git diff --stat <deployed-commit-or-branch> HEAD -- migrations/
```

Any file listed there means a backup comes first:

```sh
npm run backup    # → backups/remote-<date>/, see backup-and-restore.md
npm test && npm run deploy
```

Migrations are append-only and applied automatically before the Worker code goes live.

**A data migration and the old Worker.** Migrations apply seconds before the new code takes
over, and in that window the old Worker still serves. Migration 0023 (reads, ARCH.md §16 #41)
is the case to watch. An edit of a book's status or dates saved by the old code in that window
doesn't make a read, and the book's next change of reading then goes by its reads. So deploy it
when nobody is editing, and don't roll the Worker back past it: older code writes status
directly.

**What 0023 does to your data.** It turns each book's status and dates into reads, and most books
come out exactly as they were. A few shapes change, all by the same rules imports use:

- A **not-started** book with a **start date** becomes **In progress**: a start date says a read
  began. One with a **completion date** becomes **Completed**.
- An **abandoned** book with a Goodreads **Read Count** becomes **Completed**, with that many
  finished reads beside the stopped one.
- A Goodreads **Read Count** becomes that many finished reads (at most 100) and leaves the book's
  details. A count that isn't a whole number (`2.0`, `3abc`, a negative) stays in details as it
  was, and still shows wherever details show.
- Pages recorded on a **not-started** book stay unattached until the book is started.

Take a backup first (above), so any of these can be undone by restoring it.

## Taking your local data to production

Been cataloging against local dev? Your catalog is a real SQLite database under
`.wrangler/state/` and comes with you. (This procedure is rehearsed: rows and the search
index restore cleanly; covers are re-fetched.)

1. Do **First deploy** steps 1–2 (create resources, set secrets), then apply the schema:
   ```sh
   npm run db:migrate:remote
   ```
2. Export local data and load it into production (FK-safe order):
   ```sh
   npm run backup:local
   for t in users libraries shares items tags item_tags loans; do
     npm run wrangler:remote -- d1 execute nalanda --remote --file=backups/local-<date>/$t.sql
   done
   ```
3. `npm run deploy`, then log in at the production URL — same username and password.
4. **Covers**: the image files live in local R2 emulation and don't transfer. Clear the
   stale references and re-fetch once:
   ```sh
   npm run wrangler:remote -- d1 execute nalanda --remote --command "UPDATE items SET cover_key = NULL"
   ```
   then production `/import` → **Cover backfill** (a few minutes).
5. From here, treat production as the source of truth. Local dev keeps its own separate
   copy — reset it whenever with `rm -rf .wrangler/state && npm run db:migrate`.

## Go-live checklist

- [ ] `npx wrangler d1 create nalanda` → keep the `database_id` for `D1_DATABASE_ID`
- [ ] `npx wrangler r2 bucket create nalanda-covers`
- [ ] `npx wrangler secret put SESSION_SECRET` (`openssl rand -base64 32`)
- [ ] `npx wrangler secret put DISCOGS_TOKEN` (vinyl lookups)
- [ ] `npx wrangler secret put BGG_TOKEN` (board game search)
- [ ] optional: `npx wrangler secret put GOOGLE_BOOKS_KEY`
- [ ] optional: `npx wrangler secret put HOME_SHARE_TOKEN` (front door → share page)
- [ ] data: migrate the local catalog (section above) — or start fresh via `/setup`
- [ ] `npm test && D1_DATABASE_ID=<id> npm run deploy`
- [ ] smoke: log in, scan one barcode, open a share link in a private window
- [ ] if migrated: run **Cover backfill** on production
- [ ] first production backup: `npm run backup`
- [ ] add family members (Members page)
- [ ] later, optional: custom domain · Cloudflare Access in front

## Rollback

- **Code**: `npx wrangler rollback` reverts the Worker to the previous deployment. Not past
  migration 0023, though: code from before it writes reading state without reads (§16 #41).
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
- **BoardGameGeek** (board game search): BGG made its XML API registration-only in 2025, and
  answers every unregistered request with 401. Sign in at boardgamegeek.com, register an
  application at <https://boardgamegeek.com/applications>, and create a token for it. Set it as
  the `BGG_TOKEN` secret; for `npm run backfill:remote`, put it in `.dev.vars` too. Without it,
  board game search shows a notice asking for the token, and manual entry still works.
- **Open Library**: no key, nothing to do.

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
