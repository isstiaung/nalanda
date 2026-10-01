# §16 #58 — A member can recommend one of the household's items to a connected household; theirs arrive in a Recommended list, to want or dismiss

**Decided:** 2026-09-30 (recommendations). Cited as `ARCH.md §16 #58`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner decided four points:
- **"Recommend to…" on an item's page**: pick a connected household, add a note if you like, send.
- **The receiving household** gets a notification (`recommendation`, household-wide — not an admin
  kind) and a **Recommended** page listing the item as they sent it — title, creators, their cover
  from their own `/covers/<uuid>` as every peer item's is — with the note and who sent it.
- **From that list**, anyone there can **Add to my want list** (their own, #53) or **Dismiss** it.
- **Signed with `outwardName()`**: the display name while names go to connections, else "A member",
  never a username (#45).

**The message.** A new directed type, `Recommend`, in the ActivityStreams envelope comments and
borrowing use (connections.md §9–§10): `{ item, recommender, note, published }`. `item` is
`toRecommendedItem()` in `src/federation/items.ts` — built on `toConnectionItem()` and cut as a shelf
card is: `id`, `stamp` (which book the id means, as threads and requests carry), `view` (a connection
view holding it, for the receiver's link to the item's page on the sender's shelf), `mediaType`,
`title`, `creators`, `published`, `coverKey`, and `ids` — the item's public identifiers from its
`details`, `bgg_id` and `discogs_id` only, whole numbers, so the receiver's want finds a copy it
already has. No rating, review, read count or availability (a recommendation has no need of them),
and never the ISBN or barcode columns, which `toConnectionItem()` doesn't carry. The note is plain
text up to `MAX_RECOMMEND_NOTE_CHARS` (500). It is stored with its outgoing record and queued in one
batch (`recommendToConnection()`, #39) — only while no recommendation of that item to that household
is still on record as sent, decided inside the batch, so a double submit sends one — then pushed at
once (`pushNow`), so the member hears what happened: sent, waiting (their library didn't answer; the
outbox keeps it for their pull and the usual retries), or refused. A refusal takes it out of the
outbox and marks it refused in one batch (`dropRefused`), as a refused borrow request is declined.
Receiving is idempotent by activity id: the row and its notification are one batch, on the same
condition — not seen, and within the limits below — so a push repeated, pulled again from their
outbox, or two copies arriving at once make one row and one notification (tests do all three).

**Only items inside a connection view can be recommended — the owner's constraint, and the privacy
argument for it.** A recommendation tells the other household that the item exists here. The
connection views are the one boundary an admin draws around what connections may learn of the
catalog, and any member may recommend: without the rule, a member could reveal an item from a shelf
the admin chose not to share — a diary on "Private", a gift being hidden. With it, a recommendation
says nothing the household couldn't already read from `/federation/shelf` and `/federation/item`
except that someone here thinks they'd like it, and the note. It is checked at send time against the
live views (`recommendableItem()`, the SQL twin of `itemMatchesView()` that `sharedItem()` also
spells) and the page shows the form only for an item a view holds; an item outside every view gets a
sentence saying why, and a forged POST is refused before their descriptor is even asked for.

**Backwards compatibility — what older households do, found in their code.** Households on 1.5.0 and
older don't know `Recommend`. Their POST `/federation/inbox` runs `parseInboxMessage(parseJson(raw))`
before anything else is written or dispatched, and 1.4.0's `parseInboxMessage` returns null for any
type outside its switch — so the answer is **400 "malformed message"**, final. It never reaches
their `receiveDirected`, which is just as well: 1.4.0's dispatch is a two-way ternary whose borrowing
side has no case for it and answers `undefined`, so the route's `outcome.body` would throw a 500 — a
status a sender retries. Their outbox pull (`parseOutboxPage`) maps an unknown message to `null`,
skips it and moves its cursor past it. So the choice was between sending blind and treating the 400
as final, or asking first. **This version asks first**: its descriptor gains `accepts: ['Recommend']`
(additive — `isDescriptor()` has been byte-identical since 1.0.0 and checks only the fields it knows,
so an older household reads the new descriptor as before; the protocol stays version 1), and before
queuing a recommendation the sender fetches the household's descriptor and sends only when it lists
`Recommend` (`peerAccepts()`: only a list of short strings counts, anything else is "no"). Otherwise
nothing is queued and the member is told the household "runs an older version of Nalanda that can't
take recommendations yet". A household that listed it and later went back to an older version answers
the push with that 400, which the outbox already treats as a final refusal (4xx but 429): refused,
dropped, never retried — so no loop, and a push that never landed is retried once and stops there.
Tests hold all of this against **1.4.0's own code**, extracted with `git show v1.4.0:…` into
`test/fixtures/messages-v1.4.0.ts`, `directed-v1.4.0.ts` and `outbox-v1.4.0.ts` (its `parseOutboxPage`
and the inbox route's two parse lines, word for word); 1.5.0's `messages.ts`, `directed.ts`,
`outbox.ts` and inbox route are the same files. The descriptor's `accepts` is also how the next new
type will find out who takes it.

**Limits on the receiving side.** Every directed message already counts toward
`MAX_PUSHES_PER_DAY` (200) per connection, and `MAX_INBOX_BODY_BYTES` bounds a push. On top:
`MAX_RECOMMENDATIONS_PER_DAY` (20) taken from one household per UTC day, and
`MAX_OPEN_RECOMMENDATIONS_PER_CONNECTION` (50) waiting in the list at once; past either the answer is
409, which the sender takes as final — so a household flooding recommendations costs a read and a
tick of its daily count each and stores nothing, and a dismissal makes room. Everything is checked as any connection's field is:
title up to 1,000 characters and not blank, creators and published bounded, the cover only a UUID key
(rendered only as `<their origin>/covers/<uuid>` by `coverUrl()`), the ids only the two known keys as
whole numbers, the name through `parsePeerName()` (control and bidi characters out, required — a
recommendation is always signed), the note up to 500. All of it renders only as escaped text — the
list wraps peer text in `<bdi>` so a right-to-left name can't reorder the line around it, and nothing
from a peer goes into an attribute but the link and the cover URL, both built here from checked ids.
Dismissed and taken ones are kept 60 days (`RECOMMENDATIONS_KEPT_DAYS`, past any outbox's 30-day
retention, so a late copy still finds its row), then pruned in the receiving batch. **Dismiss is the
only answer**: no per-household block — disconnecting is that, and takes their recommendations with
it (`ON DELETE CASCADE`). The sender is sent nothing about what happened to one — but an item wanted
onto a shelf that a connection view holds shows on that shelf as any item does, Not owned and Wanted
(#53), so a household that recommended it can see that someone here wants it. The page says so.

**Found by the adversarial pass, and fixed:**
- *A cover could carry script.* Wanting a recommendation copies its cover from the other household's
  `/covers/<uuid>` into our R2, and `storeCover()` kept any `image/*` — an `image/svg+xml` with a
  `<script>`, served back publicly from this origin, runs with this origin's cookies. The first time
  another instance chose the bytes. `storeCover()` now keeps only raster types (JPEG, PNG, GIF, WebP,
  AVIF) from any source, follows no redirect for a peer's URL (`followRedirects: false`) and refuses
  one of those that names no type at all — a guess would let the peer's silence pick it; a provider's
  missing type is still read as JPEG, as it always was, since the guess can only be a raster type and
  the CSP below holds whatever the bytes are — and
  `serveCover()` sends `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  sandbox` on every cover, including any stored before.
- *A race for the last place answered 200.* Two different recommendations arriving together for the
  last open place both passed the first check; the second's batch then stored nothing and was answered
  "already received" — so its sender counted it delivered and could never send it again. Now nothing
  inserted and not seen is a 409, which the sender marks refused.
- *The sender's own limit could be sidestepped.* A refused recommendation leaves the outbox, which is
  what `MAX_SENT_PER_DAY` counts, so a member could try again and again against a household refusing
  them. Recommendations to one household are also capped at `MAX_RECOMMENDATIONS_PER_DAY` a day on
  the sending side, counted in `recommendations` whatever became of them.
- *Known, left as is:* a recommendation taken by an outbox pull rather than a push, and refused there
  for a cap, stays "Sent" on the sender's side — a pull has no way to answer, as with any directed
  message; and the name a recommendation is signed with is fixed when it is sent, as a comment's or a
  borrow request's is.

**Who.** Any member may recommend (as any member may comment or ask to borrow); the send checks this
household's own `MAX_SENT_PER_DAY` to that household first. The whole household sees the list — the
notification is household-wide — and any member may dismiss one or add it to their own want list; it
then leaves the list for everyone. The Recommended page also lists what this household sent, with
who here sent it by username — inside the app only.

**"Add to my want list"** goes through want lists' own code, never a copy of it (#53): a copy already
here takes the want — `existingForWant()` by the recommendation's BGG or Discogs id, or else the item
a recommendation of the same item of theirs (same household, id and stamp) was wanted as before
(`wantedBefore()`, which is what keeps a book, which carries no public identifier, from becoming two
items). Otherwise it joins the chosen shelf as a Not owned item made from what they sent, its cover
copied from their `/covers/` by `storeCover()`, through `createItemWithTags(…, { wantedBy })` — the
Add page's Want path. The recommendation is claimed **in that same batch**: `createItemWithTags`
gained `before`/`after` statements, and `claimRecommendation()` moves it from open to wanted and then
runs a guard — an insert of a NULL into a NOT NULL column, `WHERE changes() = 0` — so a claim that
moved nothing (a second click, another member's answer first) fails the whole batch and nothing after
it is written: no second item, no second want. `wantStatement()` is `setWant()`'s statement, exported
for the same batch on the existing-copy path.

**Export.** Received recommendations are another household's data about its own items, and a sent
one is a message, so neither is in `/export.csv` — which is this household's items — and neither
fits a column of it. That is not an exception to the portability rule the way goals are (#49): a
recommendation is no field of any item here. They leave with the rest of connections' data in the
admin's **Export connections data** (`/federation/export.json`), both ways, beside comments and
borrow requests; backups carry the table (`recommendations` after `borrowed_items` in `TABLES`). An
item made from a recommendation is an ordinary Not owned item and exports as one, its want in
`wanted_by`.

**The migration.** `0038_recommendations` (drizzle-generated) adds the `recommendations` table and
three indexes and touches nothing else; the notification kind is a TypeScript enum, not a column
constraint, so `notifications` doesn't change. It was 0037 until want lists took that number, and
was regenerated, never edited after applying anywhere. **Rehearsed** on a local copy of production's
backup of 2026-09-30 (taken on 1.4.0): 0000–0029, the per-table restore in `TABLES` order read from
`scripts/backup.mjs` (`series`, `plays`, `reading_goals`, `wants`, `purchase_links` and
`recommendations` had no file and were skipped; 5,025 rows in 29 tables), 0030–0037, then 0038 alone:
39 tables before, **none changed** by 0038 in schema or rows, the one new table empty, every
pre-existing table identical in every pre-existing column to the restore, `foreign_key_check` clean,
`integrity_check` ok. Deleted afterwards.

**Within the free plan.** The item page spends no call on the section: its two queries — the active
households with our latest recommendation of the item to each and whether a view holds it
(`recommendTargetsStatement()`), and the name it would be signed with (`outwardNameStatement()`) — ride
last in the reading log's batch (`itemPageLog(…, extra)`, the batch want lists already share, #53),
and `recommendOnItemPage()` renders from their results. Measured and pinned by a test: **14 calls with
connections on** — form showing, or no household to send to — and **11 with them off**, both what main
had before recommendations (review found the first cut at 16: a call each for the two queries).
Sending: 11 calls and two outbound fetches (their descriptor, the push). Receiving: 7.
The Recommended page: 11 before its background pull, which runs within the budgeted handle;
`appliedAlready()` asks about recommendations only when a page holds some. Tests count each.

**Chosen without asking, overrulable:** `accepts` names message types rather than features; the
descriptor is fetched on every send rather than cached (a send is rare, and an upgrade shows at once);
one recommendation of an item per household while it stands (a refused one may be sent again);
limits of 20 a day and 50 waiting from one household, and 500 characters of note; a recommendation is
signed at send time, so a later rename doesn't reach one already sent; the list shows 100; the want's
shelf is chosen on each card (first shelf by default); what the receiver does is never sent back.
