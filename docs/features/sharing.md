# Sharing

Publishing is the only way anything leaves the app, so it is deliberate, per view and admin-only
([#4](../decisions/004-public-read-publishing.md), [#23](../decisions/023-what-public-screen-badge.md)).
The full rules, surface by surface, are in [docs/privacy.md](../privacy.md).

## Share links, per view

Any filtered slice of a shelf — "my reviews", "owned sci-fi" — can be published at its own
unguessable address ([#18](../decisions/018-share-links-per-view-per.md)): on the shelf, set the
filters, open **Shelf settings**, name the link and **Publish current view**. The link captures a
type, a status, a holding and the sort, one value each (a multi-selection publishes as all), and
never the search box, Read by, Format, Borrowed from someone or a decluttering view — the note
under the button names what the link leaves out. With no filters it is the whole shelf. Any number
of links per shelf, each rotated or removed on its own; a link can't be browsed beyond its filters,
even by guessing item addresses. A tag's page publishes everything carrying the tag, on any shelf,
owned or not ([#31](../decisions/031-share-links-can-capture-tag.md)) — a hand-picked list no shelf
filter could express.

**Shared links** in the sidebar lists everything published — each link's scope, the number of items
it exposes right now, its address and its QR code — with rotate and remove. A shelf reads *Shared*
only when a filterless link exposes it entire; slices read "2 views shared". Public pages are
cached for up to an hour per Cloudflare location, so a rotated or removed link can keep answering
from an untouched location for that long ([#19](../decisions/019-share-pages-burst-shielded-per.md)).
With the `HOME_SHARE_TOKEN` secret set, a signed-out visit to `/` opens that share
([#21](../decisions/021-front-door-via-home-share.md)).

## What a share page shows

Each item passes one whitelist, `toPublicItem()` in [src/lib/share.ts](../../src/lib/share.ts):
title, creators, cover, type, publisher, year, length, description, details (a pressing, a game's
numbers — money stripped), tags, formats, language and original title, the household's average
rating and latest review with no author, and a **Not owned** badge, with **Wanted** beside it while
someone wants the item. A book's own page adds "Read N times" from two finishes on — only while it
is owned; a Not owned item never claims a read — its series name and number, and the quotes a member
chose to share; a game's or record's page adds "Played N times"; reading progress appears only
while an admin has switched **Reading progress on share pages** on, and only for a book being read
now. A record whose pressing came from Discogs carries its credit; a page showing a board game,
BGG's logo. Share pages carry `noindex`, and the site's `robots.txt` disallows everything.

**Never**: private notes, where things are kept, loans or borrowers, what is borrowed from whom, the
copies count, a record's condition, what was paid, who added an item, usernames, reads or their
dates, who read what, item history, another edition's ISBN, the gaps in a series or anyone's next
up, reading goals, a play's date or who logged it, purchase links (gift lists aside), or a link into
the app.

**Names on share pages** — an admin's switch on Shared links
([#45](../decisions/045-members-names-reach-share-pages.md)): on, a shared book's page lists each
member's rating and review under their display name, "A member" for one without, and a shared quote
is signed; off, nothing per member appears. A username never leaves the app either way.

## Gift lists

An admin can publish a member's want list from their Want list page
([#53](../decisions/053-member-has-want-list-household.md)): a share showing what they want right
now — title, creators, cover, type, publisher, year, length, description, "On the shelves" for
something the household already has, and the links pasted under **Where to buy** — and nothing
about reading: no rating, review, read count, progress, tags or details. Titled "A want list", or
"Priya's want list" only while names are on and she has a display name. It follows the list: an
item finished or no longer wanted leaves it. Purchase links are public here and nowhere else, and
open with `rel="noopener noreferrer"`, so the link's token never reaches a shop.

## Previews, feeds and QR codes

**Link previews** ([#71](../decisions/071-share-page-link-previews.md)): pasted into a chat, a share
link shows what it is — a shelf's name, its count and first cover; an item's title, creators and the
start of its description, with its cover — from Open Graph tags carrying only what the page shows.
The not-found page carries none.

**Feeds** ([#86](../decisions/086-share-feeds.md)): every share link has an Atom and an RSS feed,
`/share/<token>/feed.atom` and `.rss`, linked from the page's head, of its twenty newest additions —
title, creators, cover, the household's rating and latest review, a link to the item's share page —
dated by the day each was added, never by anyone's reading. A gift list's feed is its newest wants.
Cached with the page, gone with the token.

**QR codes** ([#85](../decisions/085-share-qr.md)): Shared links draws each address as a code in the
ledger's colours with the Nalanda mark in the middle, in the browser, with **Download PNG** — for a
card on the shelf. Nothing new is published: the code is the address.

## Rotate and remove

**Rotate** when a link spread further than meant: a new address at once. **Remove** unpublishes
that view; other links on the shelf keep working. Both are on Shared links and on the shelf, tag or
want list the link came from.
[runbooks/accounts-and-access.md → Share links](../../runbooks/accounts-and-access.md#share-links-admin-only).
