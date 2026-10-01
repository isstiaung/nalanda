# §16 #67 — A record's stored cover comes from the Cover Art Archive or nowhere, never from Discogs; the covers already stored from Discogs are replaced or dropped by a one-off run from a laptop

**Decided:** 2026-10-01 (record covers from the Cover Art Archive). Cited as `ARCH.md §16 #67`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Discogs' API Terms class
"Release Images" as Restricted Data, licensed *"limited, personal, non-sublicensable"* and not to be
transferred *"to any third party"* (#63 left this open). A stored cover lives in R2 and is served from
`/covers/` on share pages and to connections, and a peer copies it when it wants a recommendation. The owner
decided three things. A new record's stored cover comes from the Cover Art Archive (coverartarchive.org,
through MusicBrainz), never from Discogs. Discogs still supplies the pressing, which is CC0 data credited by
#63. And each cover already stored from Discogs is replaced with the archive's where it has one, or dropped,
so the record shows its placeholder.
- **Finding a cover** (`recordCover()`, src/metadata/musicbrainz.ts) tries three ways in order, and stops at
  the first image stored:
  1. *By barcode.* A MusicBrainz release search on the code, in both its UPC-A and EAN-13 forms. It takes a
     release whose barcode is the same (leading zeros aside) and whose title or artist agrees: indexes hold
     typos, as ISBN ones did (#9). It stores that release's own front, else its release group's.
  2. *By a MusicBrainz release id* in details (`musicbrainz_id`), if anyone typed or imported one. Nothing
     writes that key: a new public details key is the owner's call.
  3. *By artist and title.* A release search on the first creator and `searchableTitle()`, taking only a
     confident match (`pickRelease()`); never a guess. Both sides must name an artist, and the artist must
     match (`creatorsMatch`). The title must pass `titlesMatch` *and* be the same title once case,
     punctuation, bracketed notes and subtitles are set aside. That refuses `titlesMatch`'s prefix-only
     matches: "Live" is not "Live at Leeds", nor "Led Zeppelin II" "Led Zeppelin". When the releases that
     pass span several release groups, it takes the one plain album (primary type Album, no secondary
     type such as Live), and with no single one, nothing. It stores the release group's front: the
     album's cover, which the archive picks from the group's releases.

  Only a well-formed MusicBrainz id is ever put into an archive URL: nothing else from a response or an
  item. A failed request is a miss, never a throw.
- **MusicBrainz's rules.** The app's `USER_AGENT`, and one request a second. In the Worker the pace is per
  isolate, a best effort like BGG's (#60): an add whose barcode MusicBrainz doesn't know waits a second for
  the search. The laptop scripts also pace by host.
- **The archive's redirect** is followed by hand by `fetchCover()` (src/lib/covers.ts). It was split out of
  `storeCover()` so the laptop scripts fetch by the same rules. coverartarchive.org answers with a 307 to
  archive.org, which answers with a 302 to a storage host. Each hop must stay on coverartarchive.org,
  archive.org or `*.archive.org`, and is asked over https whatever the redirect says, for at most five hops.
  Raster types only, 500 B to 5 MB, as before — the cap applied before the body is buffered: a declared length
  over it is refused unread, and a body is read a chunk at a time and dropped the moment it passes it.
- **Never Discogs, on every path.** `fetchCover()` refuses any discogs.com host, and a redirect that ends at
  one. The paths:
  - *An add from a Discogs result* (POST /items with `source=discogs`): a search result, a barcode
    lookup, or a held scan's review list. The cover is `recordCover()`'s, never the posted `coverUrl`.
    The result's form no longer carries Discogs' URL, and a page rendered before this has it ignored.
  - *The cover backfill*, in the app and on the laptop: a record has its own pass (`findRecord()` in
    src/metadata/index.ts), with details from Discogs (by barcode, else a matching search) and a cover only
    from `recordCover()`. The barcode pass that asked Discogs and the archive about a book's or a game's
    UPC, both music databases, is gone. The laptop backfill now stores through `fetchCover()` too, so it
    also gains the raster-only rule; it used to accept any `image/*`.
  - *Wanting a recommended record* (#58): the peer's `/covers/` copy is skipped for a record, because an
    older Nalanda's cover may be Discogs' image. The cover comes from `recordCover()` on its artist and
    title.
  - *A cover URL typed* into the add or edit form is the person's own and is stored as before. A Discogs
    image URL is the exception: the form refuses it with the reason (`role="alert"`, the field marked
    invalid).
  - *Not affected:* "Refresh from Discogs" never touched covers (#55), and CSV imports carry no covers.
- **The Add page's preview is kept.** A Discogs result's card shows its image, loaded by the signed-in
  member's browser straight from Discogs while they choose. Nalanda never fetches, stores or republishes it,
  and it never reaches a share page or a connection. That is the limited, personal use the terms describe.
  The restriction bites at storing and passing on, which is what this decision removes. Dropping the preview
  is one line in `CandidateCover` if the owner reads the terms more strictly.
- **The covers already stored: provenance from the data.** The app keeps no source for a cover, so the
  one-off touches only covers the data proves came from Discogs (`coverProvenance()`,
  src/lib/record-covers.ts):
  - *From Discogs:* a record with a cover, a Discogs release id in details (every Discogs path writes one,
    #63) and `updated_at = added_at`. It was never saved since its add, so its cover is the one that add
    stored: the result's image. Replaced or dropped.
  - *Typed in by hand:* no release id, never saved since, and not from a connection. Nothing else adds a
    record with a cover, since imports bring none, so it was added with a URL someone typed. Kept.
  - *Can't be placed:* saved since it was added, or made from a connection's recommendation. An edit can
    type a new cover, and the backfill may have found this one on Discogs or on the archive. Kept, and
    counted for the owner.
- **The one-off** is `npm run record-covers:remote` (scripts/record-covers.mjs, runbooks/record-covers.md),
  shaped like #33's backfill: rehearse, export, enrich, upload, apply, status.
  - *Enrich* records nothing for a record whose "no cover" answer came while a request was failing, so a
    flaky network never drops a cover.
  - *Apply* wants a backup less than 12 hours old, as #33's does. It works in batches of 50 statements,
    one D1 call each. Each UPDATE re-checks the id, `added_at` (ids are reused), the media type and the
    cover held at export, and stamps `updated_at`, so connections see the change and a re-export no
    longer counts the record as an untouched Discogs add. After each batch it reads the rows back, and
    only then deletes from R2 the old objects no item points at any more, and any new one a changed row
    never took. Run twice, it changes nothing.
  - *Rehearse* restores a backup into a throwaway local database and bucket, with every connection's address
    pointed at `http://127.0.0.1:9`. It adds a test record for each case and checks rows and objects.
- **Rehearsed** on a local copy of `backups/remote-2026-09-30-3`. It holds one record cover, and it is from
  Discogs: Nirvana's *MTV Unplugged in New York*, added from a Discogs search on 2026-07-19 and never saved
  since. The archive replaces it: a search match, release group `fb3770f6…`, the album's cover. Nothing was
  typed in by hand, and nothing couldn't be placed. A further eight live searches matched six to the right
  album. They refused two and matched nothing wrongly: The Who's *Live* (only prefixes of other titles),
  and A. R. Rahman's *Roja* (no confident match).
- **Old keys elsewhere.** An outgoing recommendation or an incoming borrow request keeps the cover key it was
  sent with. Once the old object is deleted, that row's cover shows the placeholder; production has none.
- **Cost.** No migration and no D1 call added to any page. An add from a Discogs result makes one or two
  MusicBrainz requests and up to three hops per image tried (about ten subrequests at worst). The in-app
  backfill's batch of two stays under 50.
- **Tests:** test/record-covers.spec.ts (adds, typed URLs, the backfill, the confidence rule, the pace),
  test/record-covers-replace.spec.ts (provenance, and the apply's batches against a local D1 and bucket),
  and test/recommend.spec.ts (a wanted record).

**Chosen without asking, overrulable:** keeping the Add page's preview; refusing a typed Discogs image URL
rather than storing it; a wanted recommended record's cover from the archive rather than the peer's; the
release group's front for a search match, the album's cover rather than the exact pressing's; reading a
`musicbrainz_id` but never writing one; dropping the UPC pass for books and games; keeping every cover
that can't be placed; the one-off stamping `updated_at`.
