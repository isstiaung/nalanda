# Backfilling covers and descriptions from your machine

The in-app backfill (**/import → Run backfill**) is fine for topping up a few dozen items. For a
large catalog, such as a fresh Goodreads or libib import, or when the in-app run keeps stopping with
**"request failed (500)"**, run the backfill from your own machine instead.

It uses the same matching code as the app (`src/metadata`), so it makes the same matches. It runs
under Node instead of inside a Worker, so the free plan's per-request limits (10 ms of CPU, 50
outbound requests) don't apply. It can also pace itself for each provider and retry failed requests.

Nothing it writes can overwrite your data. It only fills fields that are empty, and every update
re-checks, at the moment it runs, that its field is *still* empty. Anything written after the
export, whether by you or by the in-app backfill, wins.

## Before you start

- **Node 22.18 or newer**. Check with `node --version`. The script loads the app's TypeScript
  directly, and Node only does that natively from 22.18.
- **Logged in to Cloudflare**, the same as for backups. Check with `npx wrangler whoami`.
- **`GOOGLE_BOOKS_KEY`** in `.dev.vars` or in your environment. Most covers come from Google Books,
  so a run without it finds descriptions but few covers.
- **Stop any in-app backfill.** If both use the same key they share its daily quota of 1,000
  requests. Running both also looks up the same books twice.

## 1. Rehearse

```sh
npm run backfill:remote -- rehearse
```

This runs every step against a throwaway local database and bucket, never your dev database or
production. It then checks:

- every cover found is in the bucket, byte for byte
- a cover that was already set is left alone
- an edit made *after* the export survives
- no description contains leftover markup
- running the same SQL a second time changes nothing

Expect `Rehearsal passed.` at the end. The lookups hit the real providers (read-only), so the
books it finds can vary from run to run. Rehearse once, and again after any change to the script
or to `src/metadata`.

## 2. Export what production is missing

```sh
npm run backfill:remote -- export
```

This takes a snapshot of every item missing a cover or a description, the same items
**/import** counts. If there's an earlier run, it's moved to `.backfill/archive/`. If that run
has results that were never applied, `export` refuses to continue. Apply them first, or pass
`--discard` to throw them away.

## 3. Try a sample, then look everything up

```sh
npm run backfill:remote -- enrich --sample 20
```

The sample is spread across the whole queue, not just the oldest items, so its hit rate tells
you something. On a fresh import, roughly half finding something is normal. A second pass finds
less, because its queue is what the first pass couldn't find.

What matters more is the per-provider request summary printed at the end. If a provider's `ok`
count is near zero, the problem is the run, not your books. Stop there rather than run the whole
queue. See [When things go wrong](#when-things-go-wrong).

Then run the rest:

```sh
npm run backfill:remote -- enrich
```

- **It resumes.** Ctrl-C stops it after the items in flight. Running it again continues where
  it stopped.
- **It's slow by design:** about 5 seconds an item, so roughly 90 minutes per 1,000 items.
  Open Library gets one request a second, because it refused this project's connections outright
  when pushed harder. Leave `--rps` at 1, or 2 at most.
- **It stops rather than guess.** If a provider fails 15 times in a row, it stops. Answers
  given during the failure aren't recorded, so the next run looks those books up again instead
  of marking them "not found".
- **It prints requests per provider** at the end. A near-zero `ok` count anywhere is worth
  reading before you apply.

Other options:

- `--limit N` stops after N items.
- `--concurrency N` sets how many items are looked up at a time (default 3).
- `--retry-misses` looks up again everything that came back empty. Use it if a run hit
  provider trouble.

## 4. Upload the covers

```sh
npm run backfill:remote -- upload
```

This puts the covers found into R2. It must happen before `apply`, which only ever points an
item at a cover that's already in the bucket. A failed upload just leaves that item without a
cover this time. Run `upload` again to retry it.

## 5. Back up, then apply

```sh
npm run backup
npm run backfill:remote -- apply
```

`apply` refuses to run unless there's a production backup less than 12 hours old (see
[backup-and-restore.md](backup-and-restore.md)). It prints the gaps before and after:

```
Before: 200 missing a cover, 1100 missing a description (of 2000)
After:  150 missing a cover, 500 missing a description (of 2000)
Filled: 50 covers, 600 descriptions
```

Running it twice is harmless: the second run finds nothing left to fill.

## 6. Check

```sh
npm run backfill:remote -- status
```

This shows how far the run got, what's still unapplied, and the live counts. The **/import**
page shows the same live counts.

## A second pass, when Google Books was out of quota

Google Books allows 1,000 requests a day, and the quota resets at midnight US Pacific time. If a run
reports `Google Books: exhausted`, it carries on with Open Library and iTunes. Descriptions still
come through, but few covers do.

Once the quota has reset, run a second pass:

```sh
npm run backfill:remote -- export
npm run backfill:remote -- enrich --require-google-books
npm run backfill:remote -- upload
npm run backup
npm run backfill:remote -- apply
```

`--require-google-books` makes the run stop as soon as the quota runs out, rather than spend
the rest of the queue on providers that already said no. If it stops partway:

1. Upload and apply what it found.
2. **The next day, run `enrich --require-google-books` again, without exporting.** It continues
   from where it stopped. Exporting again would start over and ask Google Books about books it
   has already turned down.

## When things go wrong

- **"Open Library is not answering from this machine right now."** Open Library blocks an IP
  that sends too many requests. The block lifted within an hour last time. Nothing was
  recorded, so just run the same command again later.
- **"Stopped early: 15 consecutive failures from …"**: that provider is having trouble. What
  was found before the failures is kept. Re-run `enrich` later.
- **A sample finds nothing.** First check the per-provider request counts. If the providers are
  answering, your items may simply be hard to find: Indian-press editions, titles in other
  scripts, and misspellings often are. Another common reason is a queue made mostly of items
  that already have covers, which only want descriptions. Look one of those books up on
  openlibrary.org by hand: if it's there, something is wrong with the run.
- **Undoing an apply.** Everything it wrote went into fields that were empty before. Restoring
  the backup from step 5 undoes it, and also undoes anything else changed since that backup, so
  do it soon or not at all. See [backup-and-restore.md](backup-and-restore.md).

## What it leaves on disk

Everything lives under `.backfill/`, which git ignores:

| Folder | Contents |
|---|---|
| `production/` | the current run: queue, results, downloaded covers, the generated SQL |
| `archive/` | earlier runs |
| `rehearsal/` | the last rehearsal |

Downloaded covers stay here after they're uploaded. Delete `.backfill/archive/` and
`.backfill/rehearsal/` whenever you like. Keep `production/` until its results are applied.
