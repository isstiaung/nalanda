// Credit owed to a metadata provider, shown beside what it supplied: BoardGameGeek's (ARCH.md §16 #44) and Discogs'
// (§16 #63, below).
//
// BoardGameGeek's XML API terms: "We require that you include the 'Powered by BGG' logo (linked back to
// BoardGameGeek) in public-facing uses of the our XML API", displayed "at a size such that the text is easily
// legible" (boardgamegeek.com/wiki/page/XML_API_Terms_of_Use). The two files in public/bgg/ are BGG's own, unmodified
// (THIRD-PARTY.md): the colour logo for light pages and the reversed one, with white lettering, for the dark theme.
import type { FC } from 'hono/jsx';
import type { MediaType } from '../db/schema';
import { isRecord } from '../lib/condition';
import { isBlank, releaseIdOf } from '../lib/pressing';

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

// ---------- Discogs (ARCH.md §16 #63) ----------
//
// Discogs' API Terms of Use (support.discogs.com/hc/en-us/articles/360009334593, "Last Updated: May 27th, 2025"):
// "You must display the following notice directly next to any data You use from the Discogs API: “Data provided by
// Discogs.” The notice must include a hyperlink to the discogs.com page that includes the data. The link back must
// not use any mechanism that prevents passing along search engine ranking credit to that page, such as 'nofollow'."
// And "prominently on Your application and any other public-facing use", the notice below, word for word. Text only:
// the terms ask for no logo, and Discogs' Application Name and Description Policy keeps its mark from being the most
// prominent thing on a page.

/** The notice the terms ask for, word for word. */
export const DISCOGS_NOTICE =
  'This application uses Discogs’ API but is not affiliated with, sponsored or endorsed by Discogs. ‘Discogs’ is a trademark of Zink Media, LLC.';

/** What Discogs fills in a record's details (§16 #55), beside the release id: what the credit is for. */
const FROM_DISCOGS = ['label', 'catno', 'country', 'year', 'format', 'genres', 'tracklist'] as const;

/** A release's page on discogs.com — only digits in its path — or discogs.com itself when there's no usable id. */
export const discogsUrl = (id: number | null | undefined): string =>
  typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? `https://www.discogs.com/release/${id}` : 'https://www.discogs.com/';

/**
 * Where a record's Discogs credit links, or null when it owes none. The rule: a record (`vinyl`, `music`) whose
 * details hold a Discogs release id and at least one field Discogs fills. The id is the provenance — every path that
 * writes Discogs' data writes the release id with it (an add from a result, "Refresh from Discogs"), and a record
 * typed in by hand has none — so a manual entry, even one with a label typed in, is never credited to Discogs. The
 * link is the release's page, built from the id only once it is a positive whole number (`releaseIdOf()`), never
 * from text; an id that isn't one (typed by hand, or sent by a connection) links to discogs.com instead.
 */
export function discogsLink(item: { mediaType: MediaType; details: Record<string, unknown> }): string | null {
  const { details } = item;
  if (!isRecord(item.mediaType) || isBlank(details['discogs_id'])) return null;
  if (!FROM_DISCOGS.some((k) => !isBlank(details[k]))) return null;
  return discogsUrl(releaseIdOf(details));
}

/**
 * "Data provided by Discogs.", linked to the page the data is on. No `nofollow`, which the terms forbid, and no new
 * tab. `noreferrer`, as BGG's link has: on a share page the address is the share's token, and a click through to
 * Discogs shouldn't carry it; it has nothing to do with ranking credit. The hidden words, after the terms' own, tell
 * a screen reader where the link goes.
 */
export const DiscogsCredit: FC<{ href: string }> = ({ href }) => (
  <a href={href} class="discogs-credit" rel="noreferrer">
    Data provided by Discogs.
    <span class="visually-hidden">{href === discogsUrl(null) ? ' Discogs home page' : ' This release on discogs.com'}</span>
  </a>
);

/** The terms' notice, in small print. */
export const DiscogsNotice: FC = () => <p class="discogs-notice">{DISCOGS_NOTICE}</p>;

/** The credit and the notice, as a block right below the pressing they credit. */
export const DiscogsAttribution: FC<{ href: string }> = ({ href }) => (
  <div class="discogs-attribution">
    <p>
      <DiscogsCredit href={href} />
    </p>
    <DiscogsNotice />
  </div>
);
