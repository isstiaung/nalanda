# §16 #36 — Notifications are in-app, per person, and only about connections

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #36`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A household redeemed an
invitation and nothing told anyone to confirm it. Push was considered and set aside — a service
worker, VAPID keys and a subscriptions table for a household app that's checked daily. Stored
notifications cover the discrete events someone may need to act on or would want to know:
connection requested, accepted, declined, withdrawn, disconnected; a borrow requested,
withdrawn, accepted, declined, returned; a comment. Each is recorded behind the check that
proved the event happened — the `federation_seen` replay marker, `setRequestStatus`'s return,
`insertComment`'s conflict — so a message replayed from an outbox notifies once. And each is
written in the same batch as its change, on the change's own precondition (`notifyIf`): as two
calls, an outbox pull that ran out of budget between them kept the change, and the replay —
seeing it made — skipped the message, so its notification never came. The same failure hit
whatever went before its effect: a connection message's replay marker was written first and
alone, so a failure after it turned the retry away as "already processed" with nothing done,
and a redeemed invitation that failed to notify left a request no admin was told about. The
marker, the effect and the notice are now one batch (`applyConnectionMessage`, `redeemInvite`).
Names and titles are copied in,
so a notification still reads after a disconnect, and render as escaped text; `href` is always
built here. Connection kinds reach admins only, since only admins can act on them. Feed activity
is counted, not notified — a notification per progress update would bury everything else.
Read state is per person as an id watermark (`notifications_seen_id`, `feed_seen_id`), not a
time: the Feed page pulls after it responds, usually inside the same second, and a time marker
would count what that pull brings in as seen. The page marks the feed seen *before* starting
its pull, in one statement, and marks notifications up to the newest one shown, not "now". One
extra query per page, only on an instance with connections. On a phone the sidebar folds away,
so the mobile bar carries its own badge. `remote_activities.id` was a plain rowid, so when the
newest stored entry was withdrawn the next one could reuse its id and fall below a reader's
watermark; migration 0019 rebuilds the table with AUTOINCREMENT (hand-written — drizzle-kit wraps
rebuilds in PRAGMA foreign_keys, which D1 doesn't honour in a migration; nothing references the
table, so the drop is safe with foreign keys on). Kept six months. Migrations 0016–0018 (0017/0018
replace 0016's first-draft time columns; drizzle-kit can't answer its rename prompt
non-interactively, so the swap is a drop then an add).
