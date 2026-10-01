# §16 #44 — BoardGameGeek's "Powered by BGG" logo sits beside its data

**Decided:** 2026-09-29 (BoardGameGeek's terms). Cited as `ARCH.md §16 #44`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

BGG approved this app's
use of its XML API as a non-commercial, public-facing application, and its terms make the
logo a condition: "public facing apps must include the 'Powered by BGG' logo, which should
link back to BoardGameGeek", sized "so that the text remains easily legible"
(boardgamegeek.com/using_the_xml_api, wiki/page/XML_API_Terms_of_Use). It appears where
BGG's data does, not on every page: under BGG results in the Add page's search, on a board
game's page, and in the footer of a share page that shows a board game — the share list
when any game on that page of it is one, a shared item when it is. The rule is the media
type, not whether a game's fields came from BGG this time: every board game Nalanda fills
in is filled from BGG, and a rule that inspects the data would need provenance the schema
doesn't keep. On share pages the logo is an attribution, not item data, so it stays
outside `toPublicItem()` (§9): it reveals only that a board game is on the page, which the
page already says, and its link leaves with `rel="noreferrer"` so a share's token never
travels to BGG. BGG's own SVGs are committed unmodified in `public/bgg/` — the colour file
for the light theme and the reversed one, white lettering, for the lamp-lit dark theme,
swapped by a `<picture>` on `prefers-color-scheme` — 32px tall, served as static assets
before the Worker, and covered by `MISSING_ASSET` so a missing one is a plain 404, never a
login redirect. They are BGG's trademark, not MIT (THIRD-PARTY.md). Not credited: a
connected household's board games on Feed and shelves, which the peer fetched from BGG
under its own terms, and the signed-in shelf tables, which a board game's own page covers.
BGG forbids modifying its data, so a description is kept whole (the owner's call): the
provider only decodes the character references BGG's XML leaves escaped (`&#039;`,
`&mdash;`, line breaks) and drops spaces before a line break. It used to cut descriptions
at 2,000 characters and collapse blank lines, losing paragraphs. One term stays with the
owner: BGG may change its terms at any time (the Geek Tools News forum announces changes).
