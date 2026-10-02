# Updating your instance

Nalanda is released as numbered versions: `v1.1.0`, `v1.2.0`, and so on. Each release has notes on
[GitHub Releases](https://github.com/isstiaung/nalanda/releases), and the same text is in the
repository, one file per release: `changelog/v1.2.0.md` and so on, listed newest first in
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

You deploy from your own copy of the repository, a fork or a clone. **If the notes ask for a backup, take it
first (step 3), before you bring in the release:** a newer release's backup script lists the tables its
migrations add, which your database doesn't have yet, so it can't back up the version you're running. Then
bring in the release you want:

```sh
git fetch https://github.com/isstiaung/nalanda.git --tags
git merge v1.2.0          # on the branch you deploy from; resolve anything you changed yourself
npm ci                    # the release may pin new dependency versions
npm test
```

If you've never changed the code, `git checkout v1.2.0` works just as well.

**Deployed with the button?** Your repository is a copy of a release, and its `wrangler.jsonc` holds
your database's id (ARCH.md §16 #101). If `git merge` says it is *refusing to merge unrelated
histories*, your copy doesn't share this repository's history. Take the release's files instead,
keeping your config:

```sh
git fetch https://github.com/isstiaung/nalanda.git --tags
git checkout v1.2.0 -- . ':(exclude)wrangler.jsonc'   # every file as released, but your own wrangler.jsonc
git diff HEAD v1.2.0 -- wrangler.jsonc                 # anything new in the release's config? copy it in, keeping your id
git commit -m "Update to v1.2.0"
```

A file the release removed stays behind in your copy. The notes say so when one matters.

## 3. Back up, when the notes say so

```sh
npm run backup
```

Run it with the version you're running now, before step 2 — see the note there. A code rollback never
undoes a migration, so this backup is how you would get back ([backup-and-restore.md](backup-and-restore.md)).
Moving across several releases at once, one backup before the first is enough; then follow each release's
Upgrading notes in order.

## 4. Deploy

The same way as always ([deploy.md](deploy.md)):

- **From your machine:** `npm run deploy`. It applies the migrations first, then the new code.
- **With Cloudflare's git integration:** push the updated branch it builds from. A copy made with the
  button is set up this way: push, and Workers Builds deploys.

Deploy when nobody is editing if the notes mention a data migration. For a few seconds the migration
has run while the old code is still serving.

Set any new secret the notes ask for with `npx wrangler secret put <NAME>`. Secrets take effect
immediately; no redeploy is needed.

## 5. Check

- Log in. The **Account** page shows the new version.
- Open a shelf, a book, and a share link in a private window.
- If you use connections, open **Feed**.

`npx wrangler tail` streams the live logs if anything looks wrong.

## 6. Follow up, when the notes say so

Some releases leave something for you to do after they're deployed.

**1.3.0: give each member their own reading history.** From 1.3.0 every member has their own
reads, pages, rating and review. Nothing before it recorded whose they were, so the upgrade credits
all existing history to your **first admin**, the admin account with the lowest id (normally the
one made at `/setup`). In a household of one there is nothing to do. Otherwise, as an admin:

1. Open a book — or a record or game — another member read or reviewed. With more than one
   member, its page names people.
2. **A read:** under **Reading**, beside the read, choose **Edit**, then pick the member under
   **Move** and press it. The read's recorded pages go with it.
3. **A rating or review:** under **Ratings and reviews**, choose **Edit** on it, pick the member and
   press **Move**. A member can hold one review of a book: if they already have one, delete one of
   the two first.
4. A shelf's **Read by** filter (for example "Read by me") finds what is credited to whom.

Move rather than re-import: a member importing their Goodreads export adds their own reads beside
the copies the first admin was given, and the book would count both.

Moving changes nothing that share pages or connections see: they show the household's summary,
which is everyone's either way.

## Going back

- **Code:** `npx wrangler rollback` returns to the previous deployment. It doesn't undo
  migrations, and a release's notes say when rolling back past it isn't safe.
- **Data:** restore the backup from step 3 ([backup-and-restore.md](backup-and-restore.md)). That also
  undoes anything changed since the backup, so do it soon or not at all.
