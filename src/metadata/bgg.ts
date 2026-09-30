// BoardGameGeek XML API2 — free for a non-commercial app, XML (hence fast-xml-parser), and since 2025
// registration-only: every request carries `Authorization: Bearer <BGG_TOKEN>` ("Bearer", a space, no colon),
// a token made for an approved application at boardgamegeek.com/applications. Without one BGG answers 401 to
// everything. The terms that come with it — the "Powered by BGG" logo, linked back to BGG, wherever the data is
// shown publicly — are ARCH.md §7 and §16 #44; the rules are at boardgamegeek.com/using_the_xml_api.
// No barcode endpoint exists; board games are added via name search.
import { XMLParser } from 'fast-xml-parser';
import { fetchWithTimeout, USER_AGENT } from '../env';
import { PAGE_SIZE, type Candidate, type MetadataProvider, type SearchPage } from './provider';

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
  // only with `stats=1`: BGG's community ratings, among them the complexity ("weight") poll's average
  statistics?: { ratings?: { averageweight?: { '@_value'?: string } } };
};

function num(v: string | undefined): number | undefined {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * BGG's complexity rating ("weight"): the average of its users' votes on a 1–5 scale, which `thing` answers with
 * `stats=1`. Kept to two decimals, as BGG's own game pages show it ("2.29 / 5"). A game nobody has voted on reads
 * 0 — no weight, not the lightest — and anything off the scale is no weight either (ARCH.md §16 #60).
 */
export function parseWeight(raw: string | undefined): number | undefined {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n * 100) / 100 : undefined;
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
      weight: parseWeight(item.statistics?.ratings?.averageweight?.['@_value']),
      year: num(year),
    },
    provider: 'bgg',
  };
}

/** A name folded for comparison: lower case, accents and punctuation gone, spaces collapsed. */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** How well a name matches what was typed: 0 exactly, 1 starts with it, 2 has it as whole words, 3 anywhere, 4 not. */
function matchScore(name: string, query: string): number {
  if (!query) return 4;
  if (name === query) return 0;
  if (name.startsWith(`${query} `)) return 1;
  if (` ${name} `.includes(` ${query} `)) return 2;
  return name.includes(query) ? 3 : 4;
}

/**
 * Every game in a search answer, best match for `query` first. BGG's search sends every match at once and in no
 * useful order, so keeping its first eight lost the game asked for whenever more than eight titles held the word
 * ("Cryptid" came after "48 Rooms: Cryptid Maze"). Ranked here: the name exactly as typed, then names starting
 * with it, then holding it as a word, then anywhere; a primary name before an alternate one; ties in BGG's order.
 * A game listed under several names (BGG repeats it once per matching name) counts once, by its best. A string
 * scan, not a parse: a common word can answer thousands of <item>s, and a Worker's CPU budget is 10 ms.
 */
export function rankedIds(xml: string, query: string): string[] {
  const want = fold(query);
  const best = new Map<string, number>(); // id → score, lower is better; insertion order is BGG's
  const re = /<item\b[^>]*?\bid="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/item>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const body = m[2] ?? '';
    const name = /<name\b[^>]*\bvalue="([^"]*)"/.exec(body)?.[1] ?? '';
    const primary = /<name\b[^>]*\btype="primary"/.test(body);
    const score = matchScore(fold(decodeReferences(name)), want) * 2 + (primary ? 0 : 1);
    const seen = best.get(m[1]!);
    if (seen === undefined || score < seen) best.set(m[1]!, score);
  }
  return [...best]
    .map(([id, score], order) => ({ id, score, order }))
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((g) => g.id);
}

/** What one `thing` request for a stored BGG id came back with — never text from BGG's answer, only a code. */
export type BggFailure = 'not_found' | 'busy' | 'refused' | 'unavailable';
export type BggGameResult = { ok: true; game: Candidate } | { ok: false; failure: BggFailure };

/**
 * One game by its BGG id, in exactly one request (`thing` with `stats=1`, which carries the weight) — for "Refresh
 * from BGG" (ARCH.md §16 #60). A failure is a result, never a throw: the page says why by code.
 */
export async function bggGame(token: string, id: number): Promise<BggGameResult> {
  let xml: string;
  try {
    xml = await fetchText(`${API}/thing?id=${id}&stats=1`, token);
  } catch (err) {
    if (err instanceof BggAuthError) return { ok: false, failure: 'refused' };
    if (err instanceof BggBusyError) return { ok: false, failure: 'busy' };
    return { ok: false, failure: 'unavailable' }; // a 403 from BGG's edge, another status, a timeout
  }
  let doc: { items?: { item?: ThingItem[] } } | null;
  try {
    doc = parser.parse(xml) as typeof doc;
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
  // not an <items> answer at all — an error page, or BGG's <error><message>…</message></error> — is BGG not answering
  if (!doc || typeof doc !== 'object' || !('items' in doc)) return { ok: false, failure: 'unavailable' };
  // an unknown id answers 200 with an empty <items>; the one asked for is the only one that counts
  const item = (doc.items?.item ?? []).find((i) => num(i['@_id']) === id);
  const game = item ? toCandidate(item) : null;
  return game ? { ok: true, game } : { ok: false, failure: 'not_found' };
}

export function bgg(token: string | undefined): MetadataProvider & { searchPage(query: string, page: number): Promise<SearchPage> } {
  /**
   * One page of a name search: two requests, as the first page always was — the search, ranked here
   * (`rankedIds()`), and one `thing` for this page's games (it takes at most 20 ids). BGG's search has no paging of
   * its own, so a later page asks the search again and takes the next eight from the same ranking.
   */
  async function searchPage(query: string, page: number): Promise<SearchPage> {
    if (!token) return { candidates: [], more: false };
    const found = await fetchText(`${API}/search?type=boardgame&query=${encodeURIComponent(query)}`, token);
    const ranked = rankedIds(found, query);
    const ids = ranked.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    if (!ids.length) return { candidates: [], more: false };

    const things = await fetchText(`${API}/thing?id=${ids.join(',')}&stats=1`, token);
    const doc = parser.parse(things) as { items?: { item?: ThingItem[] } } | null;
    // `thing` answers in its own order; put the games back in the ranking's
    const byId = new Map((doc?.items?.item ?? []).map((item) => [item['@_id'], item] as const));
    const candidates = ids
      .map((id) => byId.get(id))
      .filter((item): item is ThingItem => !!item)
      .map(toCandidate)
      .filter((c): c is Candidate => !!c);
    return { candidates, more: ranked.length > page * PAGE_SIZE };
  }

  return {
    id: 'bgg',
    mediaTypes: ['boardgame'],

    async lookupByBarcode(): Promise<Candidate | null> {
      return null; // BGG has no barcode lookup
    },

    async search(query: string): Promise<Candidate[]> {
      return (await searchPage(query, 1)).candidates;
    },

    searchPage,
  };
}
