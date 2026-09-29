// BoardGameGeek XML API2 — free for a non-commercial app, XML (hence fast-xml-parser), and since 2025
// registration-only: every request carries `Authorization: Bearer <BGG_TOKEN>` ("Bearer", a space, no colon),
// a token made for an approved application at boardgamegeek.com/applications. Without one BGG answers 401 to
// everything. The terms that come with it — the "Powered by BGG" logo, linked back to BGG, wherever the data is
// shown publicly — are ARCH.md §7 and §16 #44; the rules are at boardgamegeek.com/using_the_xml_api.
// No barcode endpoint exists; board games are added via name search.
import { XMLParser } from 'fast-xml-parser';
import { fetchWithTimeout, USER_AGENT } from '../env';
import type { Candidate, MetadataProvider } from './provider';

// The documented root. BGG asks that the www. subdomain not be used, as it can interfere with authorization.
const API = 'https://boardgamegeek.com/xmlapi2';

/**
 * BGG refused the token: revoked or mistyped. Only a 401 means that — BGG's Cloudflare edge answers 403 to
 * requests it wants to challenge, which is BGG not answering, not the token being wrong.
 */
export class BggAuthError extends Error {
  constructor(status: number) {
    super(`BoardGameGeek refused the request (HTTP ${status})`);
  }
}

/**
 * BGG is throttling us, or hasn't got the answer ready. Its API docs say an over-eager client gets 500 or 503
 * ("too busy"; about five seconds between requests avoids it), its edge answers 429 for the same thing, and 202
 * means the request was queued and has to be asked again. None of those says the game doesn't exist, so none may
 * read as "no results": 202 is even a success status, whose body holds no items.
 */
export class BggBusyError extends Error {
  constructor(status: number) {
    super(`BoardGameGeek is busy (HTTP ${status})`);
  }
}

const BUSY = new Set([202, 429, 500, 503]);

// The named references BGG's descriptions use; any other is left as written. Numeric ones are all decoded.
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×',
  deg: '°', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í',
  oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß',
};

/** One level of HTML character references, decoded: BGG escapes its descriptions once more than the XML needs. */
export function decodeReferences(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (ref, code: string) => {
    if (code[0] !== '#') return NAMED[code.toLowerCase()] ?? ref;
    const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ref;
  });
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'item' || name === 'link' || name === 'name',
});

async function fetchText(url: string, token: string): Promise<string> {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT, Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new BggAuthError(res.status);
  if (BUSY.has(res.status)) throw new BggBusyError(res.status);
  if (res.status === 403) throw new Error('BoardGameGeek turned the request away (HTTP 403)');
  if (!res.ok) throw new Error(`BoardGameGeek answered HTTP ${res.status}`);
  return res.text();
}

type ThingItem = {
  '@_id'?: string;
  name?: Array<{ '@_type'?: string; '@_value'?: string }>;
  yearpublished?: { '@_value'?: string };
  image?: string;
  description?: string;
  minplayers?: { '@_value'?: string };
  maxplayers?: { '@_value'?: string };
  playingtime?: { '@_value'?: string };
  minplaytime?: { '@_value'?: string };
  maxplaytime?: { '@_value'?: string };
  link?: Array<{ '@_type'?: string; '@_value'?: string }>;
};

function num(v: string | undefined): number | undefined {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function toCandidate(item: ThingItem): Candidate | null {
  const title = item.name?.find((n) => n['@_type'] === 'primary')?.['@_value'] ?? item.name?.[0]?.['@_value'];
  if (!title) return null;
  const links = item.link ?? [];
  const designers = links
    .filter((l) => l['@_type'] === 'boardgamedesigner')
    .map((l) => l['@_value'])
    .filter(Boolean)
    .slice(0, 4);
  const publisher = links.find((l) => l['@_type'] === 'boardgamepublisher')?.['@_value'];
  const year = item.yearpublished?.['@_value'];
  // Kept whole: BGG's terms forbid modifying its data (ARCH.md §16 #44). Only how it displays changes: its
  // character references (still encoded once the XML is parsed) become the characters, and spaces left before a
  // line break go — paragraphs, blank lines included, stay as BGG wrote them.
  const description = item.description
    ? decodeReferences(item.description).replace(/[ \t]+\n/g, '\n').trim()
    : undefined;
  return {
    mediaType: 'boardgame',
    title,
    creators: designers.length ? designers.join(', ') : undefined,
    publisher,
    published: year,
    description,
    length: num(item.playingtime?.['@_value']),
    coverUrl: item.image,
    details: {
      bgg_id: num(item['@_id']),
      players_min: num(item.minplayers?.['@_value']),
      players_max: num(item.maxplayers?.['@_value']),
      playtime_min: num(item.minplaytime?.['@_value']),
      playtime_max: num(item.maxplaytime?.['@_value']),
      year: num(year),
    },
    provider: 'bgg',
  };
}

/**
 * The first `limit` game ids from a search response, found with a string scan. A common title can return
 * thousands of <item>s, and parsing the whole document only to keep eight costs CPU a Worker doesn't have.
 */
export function firstIds(xml: string, limit: number): string[] {
  const ids: string[] = [];
  const re = /<item\b[^>]*\bid="(\d+)"/g;
  for (let m = re.exec(xml); m && ids.length < limit; m = re.exec(xml)) ids.push(m[1]!);
  return ids;
}

export function bgg(token: string | undefined): MetadataProvider {
  return {
    id: 'bgg',
    mediaTypes: ['boardgame'],

    async lookupByBarcode(): Promise<Candidate | null> {
      return null; // BGG has no barcode lookup
    },

    async search(query: string): Promise<Candidate[]> {
      if (!token) return [];
      const found = await fetchText(`${API}/search?type=boardgame&query=${encodeURIComponent(query)}`, token);
      const ids = firstIds(found, 8); // `thing` takes at most 20 ids
      if (!ids.length) return [];

      const things = await fetchText(`${API}/thing?id=${ids.join(',')}&stats=1`, token);
      const doc = parser.parse(things) as { items?: { item?: ThingItem[] } } | null;
      return (doc?.items?.item ?? []).map(toCandidate).filter((c): c is Candidate => !!c);
    },
  };
}
