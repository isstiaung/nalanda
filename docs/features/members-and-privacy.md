# Members and privacy

## Accounts

`/setup` on a fresh instance makes the first admin and the starter shelves, then closes. Admins add
members under **Members** with a **one-time link**, shown once with its QR code: the member opens
it, chooses their own password and is signed in, and a forgotten password gets a reset link the same
way ([#97](../decisions/097-one-time-links.md)); no email is involved, and no admin ever sees a
password ([#3](../decisions/003-access.md),
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

## The interface language

The household language set under Members ([#76](../decisions/076-language-and-original-title.md))
gives the interface its language too, where a translation is shipped — हिन्दी and தமிழ் so far,
machine-drafted and marked so until a native reader checks them; a household in any other language
keeps its items in it and the interface in English. Each member can pick another for themselves
under **Account → Language**. Share pages always carry the household's, and only their own few
strings change — never an item's data or a name
([#93](../decisions/093-interface-language.md)). To correct a draft or add a language, download the
strings from Account (`/strings/hi.json`, `/strings/ta.json`), edit the file, and either import it
under **Members → Interface translations** — this household's words, key by key, share pages
included, with **Remove** to clear it — or open a pull request so everyone gets it. The pages
not yet covered stay English and are translated page by page. An admin can also give a language a
display font of the household's own under **Members → Display font** — a `.woff2`, `.woff`, `.ttf`
or `.otf` file up to 2 MB that every page in that language, share pages included, sets its titles
in, falling back to Eczar for any letter it lacks; the file is public like a cover, and its licence
is the household's to mind ([#96](../decisions/096-display-font.md)).
[runbooks/accounts-and-access.md](../../runbooks/accounts-and-access.md).

## Sessions and sign-in

A session is a signed cookie naming the account by its id and a random key that is never reused
([#56](../decisions/056-session-names-account-id-random.md)), and the device it was made on: **Account →
Devices** lists each signed-in device by its browser and system, with when it signed in and was last
used, and signs any other one out; Log out ends this one. A session lasts 30 days from its last use
([#98](../decisions/098-device-sessions.md)). A new device can sign in without a password: **Sign in
another device** on Account shows a code to type on it (or scan), or the new device's log in page
shows a QR for a signed-in phone, which approves it by typing the number the new device shows
([#99](../decisions/099-device-pairing.md)). **Sign out other
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
