// Discogs — the vinyl database. Free personal access token; DOES support barcode
// search, which makes scanning a record sleeve work like scanning a book.
//
// Two endpoints: database search (barcode or name — each result carries label, catalogue number, country, year,
// a flat format list and genres, but no tracklist) and the release itself (labels with their catalogue numbers,
// formats with quantities and descriptions, the tracklist). Authenticated, Discogs allows 60 requests a minute.
import { fetchWithTimeout, USER_AGENT } from '../env';
import type { Pressing, Track } from '../lib/pressing';
import type { Candidate, MetadataProvider } from './provider';

type DiscogsResult = {
  id?: number;
  title?: string; // "Artist - Title"
  year?: string;
  country?: string;
  label?: string[];
  catno?: string;
  format?: string[];
  genre?: string[];
  cover_image?: string;
};

type DiscogsArtist = { name?: string; anv?: string; join?: string };
type DiscogsTrack = {
  position?: string;
  type_?: string; // 'track' | 'heading' | 'index'
  title?: string;
  duration?: string;
  artists?: DiscogsArtist[];
  sub_tracks?: DiscogsTrack[];
};
/** The parts of GET /releases/{id} that pressing details come from. */
export type DiscogsRelease = {
  id?: number;
  year?: number;
  country?: string;
  genres?: string[];
  labels?: Array<{ name?: string; catno?: string }>;
  formats?: Array<{ name?: string; qty?: string; descriptions?: string[]; text?: string }>;
  tracklist?: DiscogsTrack[];
};

const MAX_TRACKS = 400;
const MAX_TEXT = 300;

const text = (v: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
};

/** Discogs tells same-named labels and artists apart with a number: "Harvest (2)". Not part of the name. */
const bare = (name: string | undefined) => name?.replace(/\s\(\d+\)$/, '').trim() || undefined;

/** Distinct values, in order, joined — or nothing. */
const joined = (values: Array<string | undefined>, max = MAX_TEXT): string | undefined => {
  const seen = [...new Set(values.filter((v): v is string => !!v))];
  return seen.length ? seen.join(', ').slice(0, max) : undefined;
};

const positiveId = (v: unknown): number | undefined => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined);
const genreList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const g = [...new Set(v.map((x) => text(x, 60)).filter((x): x is string => !!x))].slice(0, 12);
  return g.length ? g : undefined;
};

function artistCredit(artists: DiscogsArtist[] | undefined): string | undefined {
  if (!Array.isArray(artists) || !artists.length) return undefined;
  let credit = '';
  artists.slice(0, 12).forEach((a, i) => {
    const name = bare(text(a.anv) || text(a.name));
    if (!name) return;
    credit += name;
    if (i < artists.length - 1) credit += a.join && a.join !== ',' ? ` ${a.join.trim()} ` : ', ';
  });
  return text(credit.replace(/[,\s]+$/, ''));
}

function track(t: DiscogsTrack): Track | null {
  const title = text(t.title) ?? '';
  const position = text(t.position, 20);
  if (!title && !position) return null;
  const duration = text(t.duration, 12);
  const artist = artistCredit(t.artists);
  return { ...(position ? { position } : {}), title, ...(duration ? { duration } : {}), ...(artist ? { artist } : {}) };
}

/** A release's tracklist, flattened: headings stay headings, an index track is followed by its parts. */
function tracklistOf(tracks: DiscogsTrack[] | undefined): Track[] | undefined {
  if (!Array.isArray(tracks)) return undefined;
  const out: Track[] = [];
  for (const t of tracks) {
    if (out.length >= MAX_TRACKS) break;
    if (!t || typeof t !== 'object') continue;
    if (t.type_ === 'heading') {
      const heading = text(t.title);
      if (heading) out.push({ heading });
      continue;
    }
    const line = track(t);
    if (line) out.push(line);
    if (t.type_ === 'index' && Array.isArray(t.sub_tracks)) {
      for (const sub of t.sub_tracks) {
        if (out.length >= MAX_TRACKS) break;
        const part = sub && typeof sub === 'object' ? track(sub) : null;
        if (part) out.push(part);
      }
    }
  }
  return out.length ? out : undefined;
}

/** "2×Vinyl, LP, Album, Reissue, 180 Gram, Red Translucent" — several formats (a box set) joined with " + ". */
function formatOf(formats: DiscogsRelease['formats']): string | undefined {
  if (!Array.isArray(formats)) return undefined;
  const parts = formats.slice(0, 10).flatMap((f) => {
    if (!f || typeof f !== 'object') return [];
    const name = text(f.name, 60);
    if (!name) return [];
    const qty = Number.parseInt(String(f.qty ?? ''), 10);
    const words = [
      `${Number.isSafeInteger(qty) && qty > 1 ? `${qty}×` : ''}${name}`,
      ...(Array.isArray(f.descriptions) ? f.descriptions.map((d) => text(d, 60)) : []),
      text(f.text, 120),
    ].filter((w): w is string => !!w);
    return [words.join(', ')];
  });
  return parts.length ? parts.join(' + ').slice(0, MAX_TEXT) : undefined;
}

/** Pressing details from a release (GET /releases/{id}). One pass over plain JSON: cheap, whatever its size. */
export function pressingFromRelease(r: DiscogsRelease): Pressing {
  const labels = Array.isArray(r.labels) ? r.labels.filter((l) => l && typeof l === 'object') : [];
  const names = labels.map((l) => bare(text(l.name)));
  const year = Number.isSafeInteger(r.year) && (r.year as number) > 0 ? (r.year as number) : undefined;
  return {
    discogsId: positiveId(r.id),
    label: joined(names),
    firstLabel: names.find((n) => !!n),
    // Discogs writes "none" where a label printed no catalogue number
    catno: joined(labels.map((l) => text(l.catno, 60)).filter((c) => c && c.toLowerCase() !== 'none')),
    country: text(r.country, 60),
    year,
    format: formatOf(r.formats),
    genres: genreList(r.genres),
    tracklist: tracklistOf(r.tracklist),
  };
}

/** Pressing details from a search result: everything but the tracklist, which only the release has. */
export function pressingFromSearch(r: DiscogsResult): Pressing {
  const year = Number.parseInt(r.year ?? '', 10);
  const names = (Array.isArray(r.label) ? r.label : []).map((l) => bare(text(l)));
  return {
    discogsId: positiveId(r.id),
    label: joined(names),
    firstLabel: names.find((n) => !!n),
    catno: text(r.catno, 120) && r.catno!.trim().toLowerCase() !== 'none' ? text(r.catno, 120) : undefined,
    country: text(r.country, 60),
    year: Number.isSafeInteger(year) && year > 0 ? year : undefined,
    format: joined((Array.isArray(r.format) ? r.format : []).map((f) => text(f, 60))),
    genres: genreList(r.genre),
  };
}

/** Why a single Discogs request came back empty-handed — the item page says which. */
export type DiscogsFailure = 'not_found' | 'busy' | 'refused' | 'unavailable';

export type PressingResult = { ok: true; pressing: Pressing; via: 'release' | 'barcode' } | { ok: false; failure: DiscogsFailure };

const failure = (status: number): DiscogsFailure =>
  status === 404 ? 'not_found' : status === 429 ? 'busy' : status === 401 || status === 403 ? 'refused' : 'unavailable';

export function discogs(token: string | undefined): MetadataProvider & {
  release(id: number): Promise<PressingResult>;
  pressingByBarcode(code: string): Promise<PressingResult>;
} {
  const headers = () => ({ 'User-Agent': USER_AGENT, Authorization: `Discogs token=${token}` });

  async function searchResults(params: string, limit: number): Promise<DiscogsResult[] | DiscogsFailure> {
    const url = `https://api.discogs.com/database/search?${params}&per_page=${limit}`;
    const res = await fetchWithTimeout(url, { headers: headers() });
    if (!res.ok) return failure(res.status);
    const data = (await res.json()) as { results?: DiscogsResult[] };
    return Array.isArray(data.results) ? data.results : [];
  }

  async function query(params: string, limit: number, barcode?: string): Promise<Candidate[]> {
    if (!token) return [];
    const results = await searchResults(params, limit);
    if (typeof results === 'string') return [];
    return results
      .map((r) => {
        if (!r.title) return null;
        const [artist, ...rest] = r.title.split(' - ');
        const title = rest.length ? rest.join(' - ').trim() : r.title;
        const creators = rest.length ? artist?.trim() : undefined;
        const p = pressingFromSearch(r);
        const candidate: Candidate = {
          mediaType: 'vinyl',
          title,
          creators,
          publisher: p.firstLabel,
          published: r.year,
          coverUrl: r.cover_image,
          // the scanned code, kept: it is what "Refresh from Discogs" looks the record up by when no release id is
          // stored, and what the shelf shows (an EAN-13 in the ISBN-13 / EAN column, a UPC-A in the other)
          ...(barcode ? (barcode.length === 13 ? { isbn13: barcode } : { isbn10Upc: barcode }) : {}),
          details: {
            discogs_id: p.discogsId,
            format: p.format,
            label: p.label,
            catno: p.catno,
            country: p.country,
            year: p.year,
            genres: p.genres,
          },
          provider: 'discogs',
        };
        return candidate;
      })
      .filter((c): c is Candidate => !!c);
  }

  return {
    id: 'discogs',
    mediaTypes: ['vinyl', 'music'],
    async lookupByBarcode(code: string): Promise<Candidate | null> {
      const results = await query(`barcode=${encodeURIComponent(code)}&type=release`, 3, code);
      return results[0] ?? null;
    },
    async search(q: string): Promise<Candidate[]> {
      return query(`q=${encodeURIComponent(q)}&type=release&format=Vinyl`, 8);
    },
    /** One request: the release, with its tracklist. */
    async release(id: number): Promise<PressingResult> {
      const res = await fetchWithTimeout(`https://api.discogs.com/releases/${id}`, { headers: headers() });
      if (!res.ok) return { ok: false, failure: failure(res.status) };
      const body = (await res.json()) as DiscogsRelease;
      if (!body || typeof body !== 'object') return { ok: false, failure: 'unavailable' };
      return { ok: true, pressing: pressingFromRelease(body), via: 'release' };
    },
    /** One request: the first release matching a barcode — no tracklist, but its id, for the next refresh. */
    async pressingByBarcode(code: string): Promise<PressingResult> {
      const results = await searchResults(`barcode=${encodeURIComponent(code)}&type=release`, 1);
      if (typeof results === 'string') return { ok: false, failure: results };
      const first = results[0];
      return first ? { ok: true, pressing: pressingFromSearch(first), via: 'barcode' } : { ok: false, failure: 'not_found' };
    },
  };
}
