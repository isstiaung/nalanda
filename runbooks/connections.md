# Runbook: Connections

Connections link your library with another household's Nalanda, one pair at a time. Connected
households can follow each other's reading in a feed, comment on each other's reviews, and
borrow each other's books. The design is in
[docs/proposals/connections.md](../docs/proposals/connections.md).

Connections are off until the instance has a key. Without one, every connections page and
endpoint answers 404 and nothing shows in the sidebar. Only admins see **Connections**.

## Turn connections on (once)

1. Generate this library's key:
   ```sh
   npm run federation:keygen
   ```
   It prints a fingerprint and the key, once, and writes nothing to disk.
2. Store the key as a runtime secret on the deployed Worker, pasting the whole JSON line
   when prompted:
   ```sh
   npx wrangler secret put FEDERATION_PRIVATE_KEY
   ```
   It's a runtime secret like `SESSION_SECRET` — not a build secret like
   `D1_DATABASE_ID`. `wrangler secret put` publishes a new version carrying it, so there's
   nothing to redeploy.
3. **Keep a copy in your password manager.** The key is your library's identity to every
   household you connect with. It isn't in D1, so `npm run backup` doesn't save it, and
   losing it means reconnecting with everyone (*Lost or leaked key*, below).
4. Reload the app as an admin. **Connections** appears under Circulation.

## Name your library

**Connections → This library** → enter a name → **Save**. Households you connect with see
this name and the address shown beneath it.

The address is whichever one you opened the page at, so save from the address you want
households to use — your custom domain or the `workers.dev` one. It must be `https://`.
Once you have any connection or pending request, the address stays fixed; see
*Changing address*.

## Connect with another household

Either side can invite. If you're inviting:

1. **Invite a household → Create an invitation.** The link is shown once. If you lose it,
   create another and revoke the unused one.
2. Send it privately, to someone you know. It works once, within 7 days. Whoever holds it
   can ask to connect, which is why you still confirm in step 4.
3. They paste it into **Accept an invitation** on their own library and press **Connect**.
   The request shows under **Waiting for them** on their side and **Waiting for your
   confirmation** on yours.
4. Check the address is the household you invited, then **Confirm**. Both sides move to
   **Connected**. **Decline** removes the request instead, and the invitation stays used.

If you're the one invited, it's step 3, then wait for them to confirm. **Cancel** withdraws
a request they haven't confirmed yet.

## Disconnect

**Connected → Disconnect.** It takes effect on your side immediately, and your library tells
theirs so the connection disappears there too. If their library is unreachable at that
moment it keeps showing you until they disconnect as well — but it can no longer act on
your library either way. Everything you stored from their feed is deleted. Reconnecting needs
a new invitation.

## Share your reading with connections

**Connections → Shared with connections.** Name a view and choose what it covers — one shelf
or all of them, a type, a status, owned or not — then **Share view**. Nothing is shared until
you do.

- Every connected household sees every view.
- For the books in a view they see the title, creators, cover, rating, review, when you last
  finished it, and how many times you have. Never notes, where it lives, loans, borrowers, how many copies you
  have, or the dates of your other reads.
- **Names: on for a new instance, as they were for an upgraded one** (§16 #49). **Show names to connected households** (in this section) sends one
  feed entry per person, signed with each member's display name — "Priya finished", "Ravi rated",
  "Priya started" — and lists everyone's rating and review on a book's page (ARCH.md §16 #45).
  Members without a display name stay unnamed; usernames and read dates never leave — a start or
  finish goes out only as it happens, dated then. Turning it on or off swaps what they hold at
  their next check: on, they're asked to delete the unnamed entries and pull the named ones; off,
  the reverse. They can keep what they already pulled. Renaming or removing a member, or moving
  a read or review to another member, swaps those entries the same way. Comments and borrow requests your members send are signed with
  their display name while this is on, and "A member" while it's off. Households on older
  versions get the entries without names, shown as the household's — two people finishing one
  book show as one entry.
- **Reading goals** (**Share reading goals**, just below; on for a new instance, off for an upgraded
  one) add entries when a member sets a goal, passes halfway and reaches it — "Priya reached their
  2026 goal", with the target and the count — only while names are shown too (the switch is greyed
  out until then), and only for members with a display name. Never which books or when they were
  read. A goal goes to every view that can hold books; a milestone only to views holding the book
  whose finish reached it. Off withdraws them at each connection's next check. Households on 1.3.0
  or older skip these entries and read the rest of your feed as before (ARCH.md §16 #49).
- **With names off, they see your household, never a person** (ARCH.md §16 #43). The rating is the average of
  everyone's ratings here, the review the one written last, with no name on it; "when you last
  finished it" is the latest finish by anyone, and "how many times" counts everyone's. Which of
  you read or reviewed what stays inside your household.
- What reaches them is activity: a book reviewed, rated or finished, and each page you record
  as you read. Sharing your first view includes the last 90 days of it.
- Each entry is dated by when it happened. A finish carries its **completed** date, so marking a
  book you read in 2019 as finished doesn't appear at the top of anyone's feed. A rating or review
  is dated the day you give it — and a second member's rating is news only if it moves the
  household's average; the same average sends nothing. When you share your first view, only books with a **completed**
  date in the last 90 days bring their finish, rating and review along. Earlier activity without
  a date isn't sent, because nothing says when it happened.
- **Importing** (Goodreads, libib, or a Nalanda export) while a view is shared sends nothing as
  new. Each imported read is dated by its completed date. A read without one isn't sent at all.
  A household following you sees last week's reads in last week's place. Older ones fall outside
  what they keep.
- **Reading a book again** keeps it Completed, so it stays in the views it was in: a view of
  books in progress won't show a re-read, and a view of finished books keeps it. Its pages are
  sent as you record them, and its finish, when you get there, is sent as a new finish dated
  that day. Starting or stopping a re-read sends nothing. Households on this version see
  "re-reading" and "finished again"; one on an older version sees plain reading and finished.
- **Share reading progress**, in the same section, is on by default. Turn it off and nothing new
  is sent; entries already sent are withdrawn the next time each household checks. It's
  separate from showing progress on public share links (**Shared links**), which is off by
  default.
- A household still on an older version of Nalanda won't see your reading progress, and won't
  get the entries it missed after it updates. Everything else reaches it as normal.
- **Stop sharing** removes a view. The next time a household pulls, whatever they stored from
  it is deleted.

## Notifications

**Notifications** in the sidebar lists what happened with your connections: a household asking to
connect (waiting on your confirmation), accepting or declining yours, disconnecting; someone asking
to borrow a book, withdrawing, lending you one, declining, or recording a return; a comment on a
review; a recommendation. The number beside it is how many you haven't seen. Each person in the household has their
own, and requests to connect only reach admins, who are the ones who can confirm them.

New entries in the feed of a household you follow aren't notified one by one. **Feed** shows how
many arrived since you last looked instead. On a phone the badge sits in the top bar.

Nothing is sent anywhere: no email, no push. It's a count you see the next time you open Nalanda.

## Follow a household's feed

**Connections → Feed**, next to a connected household, lists the views they share with how busy
each has been and roughly what following it would store. For each view choose:

- **Pull** — at most every 15 minutes, hourly or daily. Pulls happen only when someone opens
  Feed, never in the background.
- **Keep** — how many days of activity, and how many entries at most.

Then **Follow**, and open **Feed** in the sidebar. The first pull runs as that page loads, so
reload it a moment later. Newest entries come first; **Older** pages back.

The same page shows what each view actually stores. **Save** new limits (applied at once),
**Purge** to delete what's stored, or **Unfollow** to delete it and stop. Whatever you choose,
entries a household stops sharing are deleted at the next pull, and no connection stores more
than 1,000 entries.

## Comments

- **On their reviews:** a review card on **Feed** has **Comment**. Only reviews you follow
  can be commented on, and a thread stays on your side only while you follow that review.
- **On yours:** comments appear under the review on the book's page, one thread per
  household, and recent ones are listed at the top of **Feed**. **Reply** in the thread. A
  thread is about the household's review they saw — the one written last — whoever here wrote it.
- **Who sees a thread:** only your library and that household — never your other connections.
- **Deleting:** anyone in your household can delete a comment on your reviews, or one of your
  own anywhere, and the deletion reaches the other household too. Withdraw a comment on their
  review while you still follow it: once its entry leaves your feed, your copy of the thread
  goes with it, though theirs stays.
- **Limits:** plain text, up to 2,000 characters. A household can send you 200 messages a day;
  yours can send 100 to each household.
- **When their library is offline**, a comment waits in yours and reaches them the next time
  someone there opens **Feed**. It waits up to 30 days.

## Borrowing

**Asking:** **Borrowed → Browse connected households**, pick a shelf, open a book, and **Ask to
borrow** — with a note if you like. Only books with a copy free can be asked for; the answer
shows on **Borrowed** (*Waiting*, *Lent to you*, *Declined*), and you can **Withdraw** while it
waits.

**Lending:** requests appear at the top of **Loans**. Anyone in your household can **Lend** —
optionally with a due date — or **Decline**. Lending makes an ordinary loan to "name (their
library)", so overdue marking and **Mark returned** work as for any loan. Marking it returned
tells them.

What connections see of your books is whether a copy is free — never who has it, when it's due,
or your loan history. Shelves are read from your library when they look, never copied to theirs.

**Export:** admins can use **Borrowed → Export connections data** to download everything about
your connections as JSON: active connections, shared views, what you follow, comments,
borrowing, and recommendations sent and received.

If a book lent to a household is deleted from your catalog, or one they asked for, they're told
— as a return, or a declined request — so nothing stays waiting on their side.

## Recommendations

**Sending:** open an item on a shelf you share with connections, choose **Recommend to…**, pick a
household, add a note if you like (up to 500 characters) and **Send recommendation**. Any member
can. They see the item as your shared shelves show it, your note, and your display name while
**Show names to connected households** is on — "A member" otherwise, never your username. Items on
a shelf you don't share can't be recommended; the page says so. Each item goes to each household
once, and the page lists where it has gone.

What the page tells you:

- **Recommended to …** — it arrived.
- **… didn't answer just now** — their library is offline; it waits in yours and reaches them
  when they next open Feed, Loans, Borrowed or Recommended, for up to 30 days.
- **… runs an older version of Nalanda** — they're on 1.5.0 or older, which can't take
  recommendations. Nothing was sent. It works once they update; nothing to do on either side.
- **… couldn't take it** — they have 50 waiting, or had 20 from you today. It's marked refused
  and can be sent again later.

**Receiving:** **Recommended** in the sidebar lists what households recommend to you, with the
note and who sent it; a notification says when one arrives. Anyone in your household can
**Add to my want list** — it joins the shelf you choose as a Not owned item, or the want goes on
the copy you already have — or **Dismiss** it. Either way it leaves the list for everyone. The household
that sent it gets no reply, but an item added to a shelf you share with them shows there like any
other, Not owned and Wanted included. The page also lists what your household has recommended.

**Limits:** from one household, 20 a day and 50 waiting at once; past that theirs are turned away
until you dismiss some. Your household sends each household at most 20 a day too, refused ones
included. There's no block: dismiss, or disconnect, which removes all of theirs.

## Changing address

The address is part of your identity to connected households, so it can't change under
them. To move to a new domain:

1. Disconnect every connection, and revoke any unused invitations — their links point at
   the old address.
2. Open **Connections** from the new address and **Save**.
3. Reconnect with new invitations.

## Lost or leaked key

A lost key can't be recovered. A leaked key lets whoever holds it pose as your library to
your connections. Either way:

1. Run `npm run federation:keygen` and `npx wrangler secret put FEDERATION_PRIVATE_KEY`
   with the new key.
2. Disconnect every connection. Their libraries still hold your old key, so they'll reject
   the notice — ask each household to disconnect on their side too.
3. Reconnect with new invitations.

## Turn connections off

Disconnect everyone first, so their libraries hear about it. Then:

```sh
npx wrangler secret delete FEDERATION_PRIVATE_KEY
```

Every connections page and endpoint goes back to 404. Connection records stay in D1,
harmless, and return if the same key is put back. Shared views stay too, and while any exists
your library keeps recording activity for them — stop sharing every view first if you're
turning connections off for good.

## Try it locally with two libraries

Two local instances can connect over `http://localhost`. Give each its own state
directory, so your everyday dev database is never touched, and its own key through
`--env-file`. Everything below lives under `.wrangler/`, which git ignores.

1. Run `npm run federation:keygen` twice, one key per library.
2. Create `.wrangler/connections/a.env` and `.wrangler/connections/b.env`, each with
   ```
   SESSION_SECRET='<any long random string>'
   FEDERATION_PRIVATE_KEY='<the .dev.vars line from one keygen run>'
   ```
   `--env-file` replaces `.dev.vars` rather than adding to it, so anything else you need
   (a `DISCOGS_TOKEN`, say) goes in these files too.
3. Migrate and start each one, in separate terminals:
   ```sh
   npx wrangler d1 migrations apply nalanda --local --persist-to .wrangler/connections/a-state
   npx wrangler dev --port 8791 --persist-to .wrangler/connections/a-state --env-file .wrangler/connections/a.env

   npx wrangler d1 migrations apply nalanda --local --persist-to .wrangler/connections/b-state
   npx wrangler dev --port 8792 --persist-to .wrangler/connections/b-state --env-file .wrangler/connections/b.env
   ```
4. Open `http://localhost:8791` and `http://localhost:8792`, create an admin on each, name
   both libraries, and connect them as above.

Delete `.wrangler/connections/` to start over.

## Troubleshooting

- **No Connections link in the sidebar.** You're not an admin, or the key is missing or
  malformed. A malformed key is logged with the reason — `npx wrangler tail` while loading
  a page.
- **"Connections need this library to be served over https."** You opened the page over
  `http://` at an address other than localhost.
- **"… runs an older version of Nalanda that can't take recommendations yet."** Their descriptor
  (`<their address>/.well-known/nalanda`) has no `"accepts": ["Recommend"]`. They need to update to
  the release that brought recommendations (CHANGELOG.md); nothing else between you is affected.
- **Connect fails.** The page says why. Most often the invitation was already used,
  expired or revoked — ask for a new one — or their library couldn't be reached.
- **"No answer from …" after Connect.** The request may still have reached them, so it stays
  under **Waiting for them**. If they don't confirm, **Cancel** it and connect again.
- **"No answer from …" after Confirm.** Press **Confirm** again: if the first confirmation did
  reach them, the second completes it.
- **"Didn't accept the confirmation."** Their library refused it, often because they cancelled
  their request meanwhile. **Decline** it here and send a new invitation.
- **Feed stays empty.** Reload it — pulls run after the page loads. If it's still empty, open
  that household's Feed page from Connections: a failed pull shows under the view's name.
  "They turned the request away" usually means they disconnected on their side.
- **"They sent more than a day's allowance."** A household can add at most 500 feed entries to
  your library a day, and the rest are dropped. It resets the next day.
- **A comment hasn't arrived.** If the push missed, it's collected the next time someone in the
  receiving household opens **Feed**, at most every 5 minutes.
- **A request says the book isn't available any more.** Someone borrowed the last free copy
  since the shelf was loaded. Shelves are kept in memory for up to 5 minutes.
- **They lent me a book but Borrowed doesn't show it.** Their answer arrives when someone in
  your household opens Feed, Loans or Borrowed, at most every 5 minutes.
- **Feed covers missing.** Covers load straight from the other household's library, so they
  show only while it's online.
