# §16 #60 — "What should we play tonight?" filters the household's board games by players, time and BGG's weight, in SQL over their `details`; the weight joins `details`, and "Refresh from BGG" fills blanks for games already here

**Decided:** 2026-09-30 (what should we play tonight). Cited as `ARCH.md §16 #60`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner decided the shape: say how many **players**, how much **time**
and what **weight** (light, medium or heavy, from BGG's complexity rating); see the games that fit,
in random order, with **Pick one for us** for a single random pick; keep BGG's weight for games
added from now on; and a **Refresh from BGG** button on a game's page that fills the weight and any
missing players or playtime for games already in the catalog, blanks only, on #55's pattern.

The questions the owner left open, answered:
- **Weight bands: light below 2.0, medium from 2.0 to below 3.0, heavy from 3.0** on BGG's 1–5
  scale (`WEIGHT_BANDS` in `src/lib/games.ts`). The edges are BGG's own poll anchors — 1 "Light",
  2 "Medium Light", 3 "Medium", 4 "Medium Heavy", 5 "Heavy" — so a band is where a game's average
  sits between them. Averages cluster between about 1.2 and 4, which three equal-width bands over
  1–5 would crowd into the bottom two: about 1.3 for Codenames and 1.8 for Ticket to Ride (light:
  taught in five minutes), about 2.3 for CATAN and Pandemic and 2.4 for Wingspan (medium: the
  family-weight classics), about 3.3 for Terraforming Mars and 3.9 for Brass (heavy: an evening's
  commitment). The form labels each band with its numbers.
- **Time is conservative: the longer end must fit.** A game's time is the larger of
  `playtime_max` and `playtime_min` (a range typed backwards still counts its long end, and only a
  minimum known counts as the whole game), else the Length column (BGG's `playingtime`, which may
  be all a game typed in by hand has), and it fits when that is at most the minutes you have — an
  exact fit fits. A 60–120 minute game is not offered for an hour, however short its best case.
- **Players:** fits when the count is inside `[players_min, players_max]`, a range typed backwards
  read the right way round. Only a maximum reads as 1 up to it (`FEWEST_PLAYERS`): "up to 5" says
  nothing against a table of four. Only a minimum reads as exactly that many — the narrowest
  reading, since "2" with no maximum may be a two-player game. (Found by nalanda-review: a max-only
  game first read as exactly its maximum, so "up to 5" never came out for four.)
- **Games missing a detail get their own group, "Not enough details",** under what fits, each
  unknown fact shown as unknown. It is per filter: a game is there only when something you asked
  about is missing *and* nothing known already rules it out, so a two-player game with no weight
  never shows up for four. With no filters set, every game fits. The group points at Refresh from
  BGG as the way to fill it.
- **Last played doesn't steer the order.** The owner asked for random order, and a weighting would
  be a rule nobody could see; each game shows its last play instead ("last played 14 Sep", "not
  played yet"), read from `idx_plays_item_played` for the rows returned, as #54 planned, so the
  household can steer itself. "Pick another" never repeats the pick just shown while another fits
  (`ORDER BY id = <shown>, random()`, as #46 does).
- **Where it lives: `/play`, its own page,** linked from the Overview ("Game night", once the
  collection holds a board game) and from a shelf's header whenever the shelf page shows a board
  game or is filtered to them — both from data those pages already load, so neither adds a D1
  call. It covers every shelf: on game night a household's games are one pool. **In the app
  only:** it sits behind `requireAuth`, no share page or connection links to it, and nothing on it
  is published. It shows BGG's facts, so it carries the "Powered by BGG" credit (#44).
- **What "here" means:** board games in the collection (`copies > 0`) with a copy not out on loan
  (open loans fewer than copies). A game lent to the neighbours can't be played tonight; one of two
  copies lent still can.
- **The weight is a `details` key, `weight`, so no migration.** It is public catalogue data like the
  other BGG keys: it round-trips through the CSV's `details` column (a test exports, re-imports and
  filters the copy), shows on share pages exactly where the other BGG details do — the details
  list, labelled "Weight (1–5)" — and reaches connections as a plain number through
  `plainDetails()`, as `players_min` does. The provider reads `statistics > ratings >
  averageweight` from the `thing` answer the search already asks for with `stats=1`, kept to two
  decimals as BGG's own pages show it; 0 is BGG's "nobody voted" and, like anything off the 1–5
  scale, is no weight.

**In SQL, one call.** `gamesForTonight()` classes every board game in one pass: a CTE reads each
number with `json_extract` — a JSON number, or text that is only a number (a libib import keeps
every value as text); `json_valid()` guards details that aren't JSON, and zero or junk is no value —
then marks each game fits (1), missing a detail (0) or ruled out (NULL) from four bound parameters,
NULL meaning "any". The two steps that work out the numbers are `MATERIALIZED`: left to flatten
them into the query, SQLite copies each `json_extract` into every place a later step names the
value, and one more reference (the max-only player rule) was enough to fail every query with
`SQLITE_NOMEM` in the tests, even on ten games. `row_number()` and `count(*)` over `PARTITION BY fit ORDER BY random()` return
at most 60 of each group, at random, with the totals, so a big collection costs rows scanned, not
rows sent; the page says "Showing 60 of 205". `pickGameForTonight()` is the same CTE with `LIMIT 1`.
The page is 4 D1 calls (the session, the sidebar's two, the results; 3 since #68 made the sidebar's one) and its htmx answer 2, with or
without filters, picking or not, and with 300 more games and 600 plays (tests hold both). Filters
come from the URL through `parseGameFilters()`: whole numbers in range and the three band names;
anything else is "any".

**One handler, two renders**, as #46: the filter form is a GET to `/play` that works without
JavaScript, and htmx asks the same URL with `HX-Request` for the results alone (`Vary: HX-Request`),
swapped into `#play-results`; "Pick one for us" is a second submit button adding `pick=1`. No
`hx-push-url`, so #46's caveat about history restores doesn't arise. **Accessible:** every control
sits in its `<label>`; the results are announced by a status line (`role="status"
aria-live="polite"`) outside the swapped region, filled out of band (`hx-swap-oob="innerHTML"`) so
it stays the same live node — a whole list read aloud would drown the count. "Pick another" keeps
its id across the swap, so focus returns to it. Checked in headless Brave: the same status node
changed to "Picked 7 Wonders, from 11 games that fit." and focus stayed on "Pick another".

**Refresh from BGG: one request per click, blanks only.** `POST /items/:id/bgg` fetches
`thing?id=<bgg_id>&stats=1`, the id from `details.bgg_id` (a number, or digits as text). Without one
it asks nothing and says to add it: a title search would be two requests and a guess. It writes only
the `details` keys `players_min`, `players_max`, `playtime_min`, `playtime_max` and `weight`, and the
`length` column (BGG's playing time), each only while blank (absent, null, empty text; zero is a
value) — `fillGame()`. Title, creators, publisher, description, cover, year and `bgg_id` are never
touched, and details that don't parse as an object are left alone. The write is guarded on the
`details` and `length` it read (`applyGameFill()`), so an edit saved meanwhile wins and the page
says to refresh again: 3 D1 calls a click. **Pacing:** BGG asks for about five seconds between
requests, so an isolate lets one refresh through every five seconds and answers another click inside
that as "busy" without asking BGG (`bggRefresh()` in `src/metadata/index.ts`); BGG's own 429, 500,
503 and 202 give the same notice. A 401 is "refused"; a 403 from its edge, any other status, a
timeout, or a 200 that isn't an `<items>` answer (an error message, an HTML page) "unavailable"; an answer without that id "not found" — each a fixed
sentence chosen by a code in the redirect (`?bgg=<code>`), never text from the URL or from BGG. A
game's page never calls BGG, and tests replay BGG's XML from `test/fixtures/bgg.ts`, written in the
shape BGG's API2 returns. **Amended (after 1.6.0): it updates in place, as #55's refresh does, with
the redirect as the no-script fallback.** With `HX-Request`: a 200 whatever the result, holding the
details list (`#game-details`), the length row out of band (`#item-filled`) and the sentence out of
band into `#bgg-status`, the section's persistent `<output>`; 3 D1 calls filled, 2 otherwise, and 4 for
"changed", which reads the game again to show the edit that won (as #55's does). The
button is disabled while BGG is asked, which with the five-second pacing keeps a double click from
spending the isolate's one request on nothing, and app.js says "Asking BGG…" meanwhile.

**Chosen without asking, overrulable:** the band edges at 2 and 3; time as the longer end, with
Length as the last resort; only games with a copy not on loan, and not-owned games (`copies = 0`)
left out; one household-wide page rather than one per shelf; 60 games a group; a number box for
players and fixed choices for time (20 minutes to 4 hours; any whole number of minutes up to a day
from the URL); the weight kept to two decimals; `length` among what the refresh fills; no refresh
without a `bgg_id`; per-isolate pacing of five seconds for refreshes only (search keeps its two
back-to-back requests, as before); the links on the Overview and the shelf header rather than the
sidebar, which would cost a query on every page. Numbers 58 and 59 are left for decisions in flight
on other branches.
