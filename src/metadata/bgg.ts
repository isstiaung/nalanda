// BoardGameGeek XML API2 — free, keyless, XML (hence fast-xml-parser).
// No barcode endpoint exists; board games are added via name search (ARCH.md §7).
import { XMLParser } from 'fast-xml-parser';
import { USER_AGENT } from '../env';
import type { Candidate, MetadataProvider } from './provider';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'item' || name === 'link' || name === 'name',
});

async function fetchXml(url: string): Promise<unknown | null> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null; // BGG throttles with 429/202; fail soft, user can retry
  return parser.parse(await res.text());
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

export const bgg: MetadataProvider = {
  id: 'bgg',
  mediaTypes: ['boardgame'],

  async lookupByBarcode(): Promise<Candidate | null> {
    return null; // BGG has no barcode lookup
  },

  async search(query: string): Promise<Candidate[]> {
    const searchDoc = (await fetchXml(
      `https://boardgamegeek.com/xmlapi2/search?type=boardgame&query=${encodeURIComponent(query)}`,
    )) as { items?: { item?: Array<{ '@_id'?: string }> } } | null;
    const ids = (searchDoc?.items?.item ?? [])
      .map((i) => i['@_id'])
      .filter((id): id is string => !!id)
      .slice(0, 8);
    if (!ids.length) return [];

    const thingDoc = (await fetchXml(
      `https://boardgamegeek.com/xmlapi2/thing?id=${ids.join(',')}&stats=1`,
    )) as { items?: { item?: ThingItem[] } } | null;
    return (thingDoc?.items?.item ?? []).map(toCandidate).filter((c): c is Candidate => !!c);
  },
};
