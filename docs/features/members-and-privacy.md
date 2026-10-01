# Members and privacy

## Accounts

`/setup` on a fresh instance makes the first admin and the starter shelves, then closes. Admins add
members under **Members** with a one-time temporary password, which the member must change before
doing anything else; no email is involved ([#3](../decisions/003-access.md),
[ARCH.md §8](../../ARCH.md)). Two roles and no permission matrix: everyone catalogues, lends, reads
and reviews; **admins** alone manage members, set the household's currency and language, publish,
rotate and remove share links, run Connections, delete a shelf or items in bulk, open the Trash and
read an item's history. Removing a member takes effect on their next click; their reads, reviews
and quotes stay as a former member's, and their want list and any gift list of it go. The version
you're running is at the bottom of **Account**.
[runbooks/accounts-and-access.md](../../runbooks/accounts-and-access.md).

## Display names and the switches

A member's **display name** — optional, set on Account or by an admin — is the only name that ever
leaves the app; a username never does ([#45](../decisions/045-members-names-reach-share-pages.md)).
It appears outside only while an admin has switched names on: **Names on share pages** (on Shared
links) and **Show names to connected households** (on Connections), with **Share reading goals**
beneath the second. A new instance starts with all three on; an upgraded one keeps what it had, and
with both names switches off every published byte is as it was before names existed. Comments,
borrow requests and recommendations are signed with the display name or "A member".

## Sessions and sign-in

A session is a signed cookie, good for 30 days, naming the account by its id and a random key that
is never reused ([#56](../decisions/056-session-names-account-id-random.md)). **Sign out other
devices** on Account ends every other session and keeps this one
([#70](../decisions/070-sign-out-other-devices.md)); changing your password does the same, and an
admin's **Reset password** signs that member out everywhere — the remedy for a lost phone. Login is
throttled: ten wrong passwords in ten minutes, from one address or at one account, lock it out for
ten minutes (HTTP 429), and the current-password check under Account counts the same way. Signed-in
pages are never kept by the browser's cache, and logging out clears it, so Back on a shared phone
shows nothing of the last person. Passwords are hashed with PBKDF2 in WebCrypto.

## A read-only API

**Account → API tokens** makes a token, shown once; with it a script or a blog reads your library
as JSON — `/api/v1/items` with a shelf's filters, 250 a page; an item with its reads, reviews and
loans; search with its operators; loans; your want list and goal — and changes nothing
([#88](../decisions/088-token-api.md)). A token sees what you see, private fields included, and no
more; it dies with Sign out other devices, a password change or a reset, and can be revoked any
time — ten a member. [runbooks/api.md](../../runbooks/api.md).

## Item history

For admins, an item's page keeps **History**: each change to one of the item's own fields — title,
creators, shelf, holding, cover, notes, location, series, price, details — with who made it and
when, from every path that changes an item, kept 90 days ([#84](../decisions/084-item-history.md)).
Not reads, reviews or plays, which say who already. Nothing of it reaches a share page or a
connection.

## Trash

A deleted item — from its page, in bulk, or with its shelf — waits 30 days with everything it had:
tags, series, reads, reviews, pages, plays, loans, borrows, wants, links, editions, quotes and cover
([#74](../decisions/074-item-trash.md)). **Trash**, in Settings for admins, lists what was deleted,
by whom and when, with **Restore** and **Delete for good**; a restored item comes back on its shelf
under a new number, and to a connection as newly added. The delete itself is still a delete:
nothing trashed stays on a share link or in a connection's view, and after 30 days it is gone
whether or not anyone opens the page.

## What stays home

The rules are in [docs/privacy.md](../privacy.md), each with the code that holds it. In short: the
only things that ever leave are what a share link's whitelist shows ([sharing.md](sharing.md)), what
a connection view carries ([connections.md](connections.md)), and the lookups you make — an ISBN, a
barcode, a title, an author's name — to the metadata providers, under their terms
([THIRD-PARTY.md](../../THIRD-PARTY.md)). Nothing about your reading is sent anywhere else, there is
no recommendation engine, and the installed app keeps no page on the phone
([on-your-phone.md](on-your-phone.md)). Covers are public at random addresses, because share pages
show them.
