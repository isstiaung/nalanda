// Credit owed to a metadata provider, shown beside what it supplied (ARCH.md §16 #44).
//
// BoardGameGeek's XML API terms: "We require that you include the 'Powered by BGG' logo (linked back to
// BoardGameGeek) in public-facing uses of the our XML API", displayed "at a size such that the text is easily
// legible" (boardgamegeek.com/wiki/page/XML_API_Terms_of_Use). The two files in public/bgg/ are BGG's own, unmodified
// (THIRD-PARTY.md): the colour logo for light pages and the reversed one, with white lettering, for the dark theme.
import type { FC } from 'hono/jsx';
import type { MediaType } from '../db/schema';

/** Only board games come from BoardGameGeek. */
export const fromBgg = (item: { mediaType: MediaType }) => item.mediaType === 'boardgame';

/**
 * The logo, linking to BoardGameGeek. `noreferrer`: on a share page the address is the share's token, and a click
 * through to BGG shouldn't carry it — the app's referrer policy already strips it to the origin; this sends nothing.
 */
export const BggCredit: FC = () => (
  <a href="https://boardgamegeek.com/" class="bgg-credit" rel="noreferrer" title="Board game data from BoardGameGeek">
    <picture>
      <source srcset="/bgg/powered-by-bgg-reversed-rgb.svg" media="(prefers-color-scheme: dark)" />
      <img src="/bgg/powered-by-bgg-rgb.svg" alt="Powered by BGG" width="144" height="32" />
    </picture>
  </a>
);

/** The logo as a block of its own, below the data it credits. */
export const BggAttribution: FC = () => (
  <p class="bgg-attribution">
    <BggCredit />
  </p>
);
