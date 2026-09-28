# Updating your instance

Nalanda is released as numbered versions: `v1.1.0`, `v1.2.0`, and so on. Each release has notes on
[GitHub Releases](https://github.com/isstiaung/nalanda/releases), and the same text is in
[CHANGELOG.md](../CHANGELOG.md). The version you're running is shown at the bottom of the **Account**
page.

Updating is the same deploy you already do, with two extra steps: read the notes, and back up
when they say so.

## 1. Read the notes

Read the **Upgrading** section of every release between your version and the one you're moving to,
not just the newest. It says:

- **Whether the release runs database migrations.** They apply automatically when you deploy. When
  one changes data, the notes say what it does and ask you to back up first.
- **Whether it needs a new secret**, such as `BGG_TOKEN`, and how to set it.
- **Whether connected households on older versions are affected.** A minor release never breaks
  a connection; a major one may.

## 2. Get the code

You deploy from your own copy of the repository, a fork or a clone. Bring in the release you want:

```sh
git fetch https://github.com/isstiaung/nalanda.git --tags
git merge v1.2.0          # on the branch you deploy from; resolve anything you changed yourself
npm ci                    # the release may pin new dependency versions
npm test
```

If you've never changed the code, `git checkout v1.2.0` works just as well.

## 3. Back up, when the notes say so

```sh
npm run backup
```

A code rollback never undoes a migration, so this backup is how you would get back
([backup-and-restore.md](backup-and-restore.md)).

## 4. Deploy

The same way as always ([deploy.md](deploy.md)):

- **From your machine:** `npm run deploy`. It applies the migrations first, then the new code.
- **With Cloudflare's git integration:** push the updated branch it builds from.

Deploy when nobody is editing if the notes mention a data migration. For a few seconds the migration
has run while the old code is still serving.

Set any new secret the notes ask for with `npx wrangler secret put <NAME>`. Secrets take effect
immediately; no redeploy is needed.

## 5. Check

- Log in. The **Account** page shows the new version.
- Open a shelf, a book, and a share link in a private window.
- If you use connections, open **Feed**.

`npx wrangler tail` streams the live logs if anything looks wrong.

## Going back

- **Code:** `npx wrangler rollback` returns to the previous deployment. It doesn't undo
  migrations, and a release's notes say when rolling back past it isn't safe.
- **Data:** restore the backup from step 3 ([backup-and-restore.md](backup-and-restore.md)). That also
  undoes anything changed since the backup, so do it soon or not at all.
