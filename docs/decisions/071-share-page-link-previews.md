# §16 #71 — A share link previews where it's pasted: Open Graph tags carrying only what the page shows, and the page stays noindex

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #71`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A share link pasted into WhatsApp, iMessage, Signal or a feed showed a bare URL: no name, no
cover, nothing to say what it was. The review of 2026-10-01 listed it with the two fixes
before it (#69, #70) as thirty minutes that make every share link look finished. **The owner
decided** to add it.

**What was decided:**
- **Every share page carries Open Graph tags** (`og:type`, `og:site_name`, `og:title`,
  `og:description`, `og:url`, `og:image` and `og:image:alt` when there is a picture) and
  `twitter:card: summary`, drawn in `ShareLayout` from a `LinkPreview` each route builds
  (`src/lib/share.ts`). The 404 page carries none: it is one fixed page for every link that
  resolves to nothing, and a preview would say what a dead link had been.
- **Only what the page already shows.** A shelf or tag link previews as its name, the count
  its eyebrow shows ("12 items · a shared shelf from a Nalanda home library"; "a shared tag"),
  and the first cover on the page, in the page's own order. An item previews as its title,
  then its creators, its type, which page it is on and the start of its description, cut at a
  word, by code point (`previewText()`), with its own cover; `og:image:alt` names whose cover the
  picture is — on a listing, the first item's. A gift list previews as the title its page has —
  "A want list", or the display name only while `names_on_shares` is on (#53) — and a count.
  Every value comes from `toPublicItem()` or `toGiftItem()`, so the whitelist (§9) holds
  for the preview as for the page: never notes, a location, copies, a loan, money, a grade,
  a username. Covers are already public at `/covers/:key` (random keys, #19's cache in front).
- **`og:url` is the page's own URL, token included.** Whoever can paste the link has the
  token; the tag adds no way in. `og:image` is absolute because a chat app fetches it from
  elsewhere, built from the request's origin.
- **`noindex` stays.** A preview is for the person the link was sent to; search engines were
  never invited, and `noindex` never stopped a chat app from reading the tags.
- **The per-isolate page cache (#19) is keyed by the full URL**, origin included, so a preview
  built for one origin is never served under another.

**What it rules out:** a preview on the 404 page; `summary_large_image` (covers are portrait,
and the small card shows them whole); image dimensions in the tags (the cover's size isn't
known without reading it, which no request may do, #38); anything in a tag that the page's
body doesn't show.

`test/share-previews.spec.ts` holds it: every tag on a shelf, a tag's link, an item and a gift
list, with and without a cover, names on and off; a name and a title escaped as attributes;
nothing private in the head; `previewText()`'s cut; and no tags at all on a dead link.
