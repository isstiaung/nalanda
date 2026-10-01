# Connections

Two households that both run Nalanda can connect — one pair at a time, by invitation, confirmed by
an admin — and then follow each other's reading in a feed, comment on each other's reviews, borrow
each other's books and recommend things
([#29](../decisions/029-connections-between-self-hosted-instances.md)). Never a network, never the
fediverse: every request between the two is signed (RFC 9421 HTTP Message Signatures), the messages
are ActivityStreams 2.0 JSON, and nothing runs in the background — pulls happen when someone opens a
page. Off unless the instance has a key: without `FEDERATION_PRIVATE_KEY`, every connections page
answers 404 and nothing shows in the sidebar. The setup, the handshake, disconnecting, changing
address and a lost key are in [runbooks/connections.md](../../runbooks/connections.md); the design
and threat model in [docs/proposals/connections.md](../proposals/connections.md).

## Views: what a connection may see

Nothing is shared until an admin names a view under **Connections → Shared with connections**: one
shelf or all, a type, a status, owned or not. Every connected household sees every view. For an
item inside one they get what a share page gets ([sharing.md](sharing.md#what-a-share-page-shows))
plus when the household last finished it, how many times, and whether a copy is free — a boolean,
never who has it or when it's due. Never notes, where it lives, loans, borrowers, copies, prices,
grades, another edition's ISBN, plays, series, quotes, purchase links or item history; a record's
pressing travels as plain fields, without the tracklist. A view filtered to In progress holds
re-reads and serves only reading still going on ([#64](../decisions/064-book-being-re-read-counts.md)).

## The feed

**Connections → Feed** beside a household lists the views it shares; choose how often to pull
(every 15 minutes, hourly or daily) and how much to keep, then **Follow**. **Feed** in the sidebar
shows what arrived, newest first, one card per book per household: finished (and finished again),
rated, reviewed, and each page recorded, as a timeline
([#35](../decisions/035-progress-reaches-connections-timeline-every.md)) — sharing progress is a
switch, on by default. Every entry is dated by when it happened, and an import is never news
([#40](../decisions/040-feed-activity-dated-when-happened.md)). With **Show names to connected
households** on, each entry is one person's, signed with their display name — "Priya finished",
"Ravi started" — and a book's page lists everyone's rating and review; off, the household's,
unsigned ([#45](../decisions/045-members-names-reach-share-pages.md)). Reading goals join the feed
only while **Share reading goals** is on too ([reading.md](reading.md#reading-goals)). Usernames and
the dates of anyone's reads never leave.

## Comments

**Comment** on a review card in your Feed; comments on your reviews appear under the review on the
book's page and at the top of Feed, one thread per household, seen by the two of you alone. Plain
text, up to 2,000 characters; a household can send you 200 messages a day and yours 100 to each.
While their library is offline a comment waits in yours for up to 30 days.

## Borrowing

**Borrowed → Browse connected households**, open a book with a copy free, **Ask to borrow**. The
request appears at the top of their **Loans**, where anyone can **Lend** (with a due date) or
**Decline**; a lend makes an ordinary loan on their side and a *Lent to you* line on yours, and
their **Mark returned** tells you. Their shelves are read from their library when you look, never
copied.

## Recommendations

**Recommend to…** on an item's page sends it, with a note, to a connected household — any member
can, for an item on a shelf a view shares, signed with their display name or "A member"
([#58](../decisions/058-member-can-recommend-households-items.md)). Theirs arrive under
**Recommended**, with a notification: anyone can **Add to my want list** — as a Not owned item on a
shelf, or the want goes on a copy already here — or **Dismiss**, and nothing is sent back. Twenty a
day and fifty waiting from one household; a household on 1.5.0 or older can't take them, and the
page says so.

## Notifications

In-app, per person, only about connections ([#36](../decisions/036-notifications-app-per-person-about.md)):
connection requests (admins only), acceptances, disconnections; borrow requests, lends, declines,
returns; comments; recommendations. **Feed** counts what's new instead of notifying each entry.
Nothing is emailed or pushed.

## Versions and copies

The protocol has been version 1 since 1.0.0 and only gains optional fields, so households on
different versions keep working together; each release's notes say what an older one won't see.
Admins export everything about the household's connections as JSON from **Borrowed → Export
connections data**. A copy of the database run anywhere but production — a restored backup, a
rehearsal — sets `FEDERATION_OFFLINE=1` before its first page load, so it contacts no real household
([#92](../decisions/092-federation-offline.md)).
