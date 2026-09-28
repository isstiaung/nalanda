// BoardGameGeek XML API2 — free, XML (hence fast-xml-parser), and since 2025 registration-only: every request
// carries `Authorization: Bearer <BGG_TOKEN>`, a token issued to a registered application at
// boardgamegeek.com/applications. Without one BGG answers 401 to everything (ARCH.md §7).
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

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'item' || name === 'link' || name === 'name',
});

async function fetchText(url: string, token: string): Promise<string | null> {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT, Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new BggAuthError(res.status);
  if (res.status === 403) throw new Error('BoardGameGeek turned the request away (HTTP 403)');
  if (!res.ok) return null; // BGG throttles with 429/202; fail soft, the user can retry
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
  const description = item.description
    ? item.description.replace(/&#10;/g, '\n').replace(/\s+\n/g, '\n').trim().slice(0, 2000)
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
      const ids = found ? firstIds(found, 8) : [];
      if (!ids.length) return [];

      const things = await fetchText(`${API}/thing?id=${ids.join(',')}&stats=1`, token);
      const doc = (things ? parser.parse(things) : null) as { items?: { item?: ThingItem[] } } | null;
      return (doc?.items?.item ?? []).map(toCandidate).filter((c): c is Candidate => !!c);
    },
  };
}
