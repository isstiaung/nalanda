# Replacing record covers stored from Discogs

Discogs' API terms make its release images Restricted Data: licensed for *"limited, personal,
non-sublicensable"* use, and never to be passed to a third party. Nalanda used to store a record's
Discogs image as its cover, and covers are served on share pages and to connected households. From
this release on, a record's cover comes only from the [Cover Art Archive](https://coverartarchive.org)
(MusicBrainz's), or the record has none (ARCH.md §16 #67).

This one-off handles the covers already stored. For each record cover that came from Discogs it
stores the Cover Art Archive's cover instead, or, where the archive has none, drops it, so the
record shows its placeholder. It runs from your machine, like the
[metadata backfill](metadata-backfill.md), and uses the app's own lookup code (`src/metadata`).

## Which covers it touches

Nalanda doesn't record where a cover came from, so the script works it out from the data and
touches only covers it can prove came from Discogs:

| What the data shows | Counted as | What happens |
|---|---|---|
| A record with a Discogs release id in its details, never saved since it was added | **From Discogs**: added from a Discogs result, with that result's image | Replaced by the archive's cover, or dropped |
| A record with no release id, never saved since it was added | **Typed in by hand**: added with a cover URL someone pasted (imports bring no covers) | Kept |
| A record saved since it was added | **Can't be placed**: an edit can paste a new cover; the cover backfill may have found it on Discogs or on the archive | Kept, and counted |
| A record wanted from a connection's recommendation | **Can't be placed**: its cover was copied from theirs | Kept, and counted |

Every step prints these counts. If **can't be placed** isn't zero, decide what to do with those
covers before you start. Replace them by hand on each record's edit page (paste a cover URL, or
tick **Remove current cover**). The script leaves them alone.

## Before you start

- **Node 22.18 or newer**, and **logged in to Cloudflare** (`npx wrangler whoami`), as for the
  metadata backfill.
- **Deploy the release with this change first.** Run the one-off soon after. From the deploy on,
  no new Discogs cover is stored, so the export can't miss one. A record added between the
  deploy and the export already has the archive's cover. It still counts as from Discogs, so it
  is looked up again and gets the same cover back under a new key. That's harmless.
- No tokens are needed. MusicBrainz and the Cover Art Archive are keyless, and Discogs isn't
  asked anything.

## 1. Rehearse

```sh
npm run record-covers:remote -- rehearse --backup backups/remote-<date>
```

This restores the backup into a throwaway local database and bucket (never your dev database or
production) and points every connection's address at `http://127.0.0.1:9`, so nothing can reach
a real household. It then adds a few test records, one for each case in the table above, and
runs every step against them. It checks that:

- each replaced cover is in the bucket, byte for byte, and each dropped cover is gone
- the old images are deleted from the bucket
- typed-in and can't-be-placed covers are kept, both the row and the image
- a cover changed after the export is left as it was changed
- running apply a second time changes nothing

It finishes with counts for the backup's own records: how many record covers there are, how many
came from Discogs, how many the archive replaces, how many would be dropped, and how many are
kept. The lookups ask the real MusicBrainz and Cover Art Archive (read-only, one request a second),
for at most 20 of the backup's records (`--sample N` changes that). If there are more, the
replace and drop counts are estimated from the sample. `--offline` answers the lookups with
canned replies instead, to check the pipeline without the network.

Expect `Rehearsal passed.` at the end.

## 2. Export

```sh
npm run record-covers:remote -- export
```

This lists every record cover in production with its provenance, and prints the counts. An
earlier run is moved to `.record-covers/archive/`. If that run's results were never applied,
`export` refuses to continue. Apply them, or pass `--discard`.

## 3. Look them up

```sh
npm run record-covers:remote -- enrich --sample 5
npm run record-covers:remote -- enrich
```

For each cover from Discogs, the script looks the record up on MusicBrainz:

1. **By its barcode.** It takes a release only when the barcode is the same and the title or
   artist agrees.
2. **By a MusicBrainz release id**, if the record's details keep one as `musicbrainz_id`.
3. **By artist and title.** It takes only a confident match: the artist and the title must both
   match, the title exactly (case, punctuation and bracketed notes aside). "Live" doesn't match
   "Live at Leeds". When several albums match, it takes the one plain studio album, or nothing.

It then fetches the archive's front cover, following its redirect only to archive.org. Each
record prints what it matched (artist, title, MusicBrainz release) or why there's nothing, so
skim the list. It asks one request a second, so allow about 3 seconds a record.

**It stops rather than drop on a bad network.** If a request fails during a lookup, that record
isn't recorded and the next run asks again. After 8 failures in a row, it stops. `--limit N`
stops after N records. Running it again carries on.

## 4. Upload

```sh
npm run record-covers:remote -- upload
```

This puts the archive's covers into R2. `apply` only ever points a record at a cover that's
already in the bucket.

## 5. Back up, then apply

```sh
npm run backup
npm run record-covers:remote -- apply
```

`apply` refuses to run without a production backup less than 12 hours old that looks complete.
It works in batches of 50. For each batch:

1. One D1 call swaps or drops the covers. Each UPDATE re-checks that the row is still the same
   record and still holds the cover it had at export. A cover changed since then is left as it
   is. Each UPDATE also stamps `updated_at`, so connections see the change.
2. It reads the rows back to see which changes landed.
3. Only then does it delete the old images from R2, and only those no item points at any more.
   A new cover that a changed row never took is deleted too.

Running `apply` twice is harmless: the second run finds nothing to change and nothing to delete.

## 6. Check

```sh
npm run record-covers:remote -- status
```

This shows how far the run got and the live counts. After a full run, **from Discogs** is 0.
Share pages can show an old cover for up to an hour (their per-isolate cache, ARCH.md §16 #19).
When the old image is gone, they show the placeholder until the cache refreshes.

## Undoing it

Restoring the backup from step 5 brings back the old cover keys, but not their images. `apply`
deleted those from R2, on purpose: they are Discogs' images, which this change exists to stop
serving. A restored record shows its placeholder. Run the steps again to give it the archive's
cover.

## What it leaves on disk

Everything lives under `.record-covers/`, which git ignores:

| Folder | Contents |
|---|---|
| `production/` | the current run: queue with provenance, results, downloaded covers, uploaded and deleted keys, the SQL |
| `archive/` | earlier runs |
| `rehearsal/` | the last rehearsal |

Delete `archive/` and `rehearsal/` whenever you like. Keep `production/` until `status` shows
the run applied.
