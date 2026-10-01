# §16 #86 — A share link has an Atom and an RSS feed of its newest additions — the page's whitelist, dated by the addition, never by a read

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #86`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Someone given a share link looks at it once; a feed lets them follow it — "what's new on your
shelves" in a reader, the way a blog is followed. **The owner decided** on Atom and RSS per share
link: recent additions among the link's items, the same whitelist and names rule as the page,
never progress, twenty entries, cached with the page.

**What was decided:**
- **Two feeds per link,** `/share/:token/feed.atom` and `/share/:token/feed.rss` (Atom 1.0 and
  RSS 2.0, written by `src/lib/feeds.ts`), linked from the share page's `<head>` as
  `rel="alternate"` so a reader discovers them from the page's address. Under the share router,
  so the page cache (#19) holds them an hour per isolate as it holds the pages, and they go when
  the token is rotated or removed.
- **The page's whitelist in another shape.** Each entry is built from `toPublicItem()` (or
  `toGiftItem()` on a gift list, #53): the title, the creators, the cover's address, the
  household's rating and latest review (#43), and a link to the item's share page. Nothing the page
  wouldn't show — not the tags, not where it is kept, not a note, not a name.
- **Additions, not finishes.** The owner's note said "recent additions and finishes"; finishes
  were left out, because a feed entry needs a date and a read's date is on the list of what a share
  page never carries (#41, [privacy](../privacy.md)): a page says "Read N times" from two on and
  never when. So entries are the link's twenty newest items by `added_at` (`feedItems()`), each
  **dated by the day it was added, never the time** — the one new datum a feed adds (a share page
  orders by it but shows no date), and the day alone, so a feed never publishes the household's
  hours (review on #125). A gift list's feed is the member's twenty newest wants by the want's
  `created_at` (`wantFeedItems()`), ordered by it but **all dated by the day of the newest want**:
  the list's last change, never when one member wanted each thing. Titled as the page is titled
  ("A want list", or the display name only while names are on, #45). The owner can widen either to
  the time of day; the stricter reading is the default.
- **Twenty, newest first**, one query each; `rfc3339()` and `rfc822()` write D1's UTC
  timestamps for the two formats, the day alone; everything is XML-escaped (`xmlEscape()`), the
  entry's HTML twice over (escaped into `<content type="html">` and `<description>`), so a title
  can say anything — and the characters XML 1.0 forbids even escaped (a pasted vertical tab, a
  NUL, a lone surrogate) are taken out first, since one would make the whole feed malformed
  (review on #125).

**What it rules out:** finish entries (above); progress (never on a feed, whatever
`progress_on_shares` says — it is "being read now", not news); per-member entries or names even
with names on; feeds for anything but a share link; a feed of the household's activity log — the
connections feed is that, for connected households only (#40).

`test/share-feeds.spec.ts` holds it: the escaping and both date forms; a filtered link's feed
listing its newest additions with the page's fields, the item's share link and the addition's
date — and nothing private, no tag, no name, no reading, nothing off the link; twenty at most,
newest first; a gift list's wants by the want's date and the page's title; an unknown token; the
cache's hit and miss; the page's alternate links.
