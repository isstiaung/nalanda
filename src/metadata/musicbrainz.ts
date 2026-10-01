// MusicBrainz (which release a record is) + the Cover Art Archive (that release's front cover): the only source of a
// record's stored cover (ARCH.md §16 #67). Discogs' API terms make its images Restricted Data — "limited, personal,
// non-sublicensable", not to be passed to third parties — and a stored cover is served on share pages and to
// connections, so a record's cover comes from here or not at all. Discogs still supplies the pressing (CC0 data).
//
// Both keyless and free. MusicBrainz asks for a meaningful User-Agent and at most one request a second from a client:
// every request here takes its turn (per isolate in the Worker, a best effort like BGG's; the laptop scripts also pace
// by host). The Cover Art Archive answers a cover URL with a redirect to the Internet Archive, which fetchCover()
// follows only to archive.org and coverartarchive.org (src/lib/covers.ts).
import { fetchWithTimeout, USER_AGENT } from '../env';
import { creatorsMatch, normTitle, searchableTitle, titlesMatch } from './provider';

const MUSICBRAINZ = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org';

/** MusicBrainz's rate limit is one request a second. */
export const MUSICBRAINZ_GAP_MS = 1000;
let nextRequestAt = 0;

/** Tests only: forget the last request, so one test's lookup doesn't pace the next's. */
export function resetMusicBrainzPacing(): void {
  nextRequestAt = 0;
}

/** One request to MusicBrainz's web service, a second after the last one from this isolate. */
async function musicbrainz(path: string): Promise<Response> {
  const now = Date.now();
  const at = Math.max(now, nextRequestAt);
  nextRequestAt = at + MUSICBRAINZ_GAP_MS;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  // awaited here, not returned: a request that fails at once is then handled the moment it fails
  return await fetchWithTimeout(`${MUSICBRAINZ}${path}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A MusicBrainz id: nothing else — from a response or from an item — is ever put into a Cover Art Archive URL. */
export const isMbid = (v: unknown): v is string => typeof v === 'string' && MBID.test(v);

export const releaseFront = (mbid: string) => `${CAA}/release/${mbid.toLowerCase()}/front-500`;
/** An album's cover: the archive picks it from the group's releases that have one. */
export const groupFront = (mbid: string) => `${CAA}/release-group/${mbid.toLowerCase()}/front-500`;

/** What a release search answers about one release — only what matching it needs. */
export type MbRelease = {
  release: string;
  group: string | null;
  title: string;
  /** The artist credit as it reads: "Simon & Garfunkel", "Miles Davis Quintet". */
  credit: string;
  barcode: string | null;
  /** Its release group is a plain album — no live, compilation or other secondary type. */
  album: boolean;
};

function creditOf(credit: unknown): string {
  if (!Array.isArray(credit)) return '';
  return credit
    .slice(0, 12)
    .map((a) => {
      const part = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
      return `${typeof part.name === 'string' ? part.name : ''}${typeof part.joinphrase === 'string' ? part.joinphrase : ''}`;
    })
    .join('')
    .trim()
    .slice(0, 300);
}

export function parseRelease(raw: unknown): MbRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isMbid(r.id) || typeof r.title !== 'string') return null;
  const rg = (r['release-group'] && typeof r['release-group'] === 'object' ? r['release-group'] : {}) as Record<string, unknown>;
  const secondary = rg['secondary-types'];
  return {
    release: r.id.toLowerCase(),
    group: isMbid(rg.id) ? rg.id.toLowerCase() : null,
    title: r.title.slice(0, 500),
    credit: creditOf(r['artist-credit']),
    barcode: typeof r.barcode === 'string' ? r.barcode : null,
    album: rg['primary-type'] === 'Album' && !(Array.isArray(secondary) && secondary.length > 0),
  };
}

async function searchReleases(query: string, limit: number): Promise<MbRelease[]> {
  const res = await musicbrainz(`/release/?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { releases?: unknown };
  return Array.isArray(data.releases) ? data.releases.map(parseRelease).filter((r): r is MbRelease => !!r) : [];
}

/** A barcode as a number: "0720642472712" (EAN-13) and "720642472712" (UPC-A) are the same code. */
const barcodeKey = (code: string) => code.replace(/\D/g, '').replace(/^0+/, '');

/** A Lucene phrase: only a quote and a backslash mean anything inside one. */
const phrase = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;

type Subject = { title: string; creators?: string | null };

/**
 * The release carrying this barcode — its exact pressing — when it doesn't contradict the item: the barcode must be
 * equal (leading zeros aside), and its title or its artist must match the item's. A barcode is an identifier, but
 * indexes hold typos, and a record whose title and artist both differ is someone else's.
 */
export async function releaseByBarcode(barcode: string, subject: Subject): Promise<MbRelease | null> {
  const key = barcodeKey(barcode);
  if (key.length < 7) return null;
  const digits = barcode.replace(/\D/g, '');
  const forms = [...new Set([digits, key, key.padStart(12, '0'), key.padStart(13, '0')])].filter((f) => f.length >= 8);
  const found = await searchReleases(forms.map((f) => `barcode:${f}`).join(' OR '), 5);
  const artistOk = (r: MbRelease) => !!r.credit && !!subject.creators?.trim() && creatorsMatch(subject.creators, r.credit);
  return found.find((r) => r.barcode !== null && barcodeKey(r.barcode) === key && (titlesMatch(r.title, subject.title) || artistOk(r))) ?? null;
}

/**
 * The confident match among a release search's answers, or none — never a guess (ARCH.md §16 #67). Each of these must
 * hold: the item names an artist and the release credits one; the artist matches (creatorsMatch: the item's first
 * creator's surname is in the credit); the title matches (titlesMatch) and is the same title once bracketed notes and
 * subtitles are set aside — "Live" is not "Live at Leeds", and "Led Zeppelin II" is not "Led Zeppelin", though both
 * pass titlesMatch's prefix rule. When the releases that pass are from more than one release group, it takes the one
 * group that is a plain album, and with no such single group, nothing.
 */
export function pickRelease(found: MbRelease[], subject: Subject): MbRelease | null {
  if (!subject.creators?.trim()) return null;
  const wanted = normTitle(searchableTitle(subject.title));
  const confident = found.filter(
    (r) =>
      !!r.credit &&
      creatorsMatch(subject.creators, r.credit) &&
      titlesMatch(r.title, subject.title) &&
      normTitle(searchableTitle(r.title)) === wanted,
  );
  // the first release of each group, in MusicBrainz's order (best match first)
  const groups = new Map<string, MbRelease>();
  for (const r of confident) if (!groups.has(r.group ?? r.release)) groups.set(r.group ?? r.release, r);
  if (groups.size <= 1) return confident[0] ?? null;
  const albums = [...groups.values()].filter((r) => r.album);
  return albums.length === 1 ? albums[0]! : null;
}

/** A release search on artist and title, and its confident match (pickRelease). */
export async function releaseBySearch(subject: Subject): Promise<MbRelease | null> {
  const artist = subject.creators?.split(',')[0]?.trim();
  if (!artist) return null;
  const found = await searchReleases(`release:${phrase(searchableTitle(subject.title))} AND artist:${phrase(artist)}`, 10);
  return pickRelease(found, subject);
}

export type RecordCoverSubject = Subject & {
  barcode?: string | null;
  /** A release id kept in the item's details (`musicbrainz_id`), if anyone put one there. */
  musicbrainzId?: unknown;
};

export type RecordCoverResult = {
  /** The stored cover, or null: no confident release, or one the archive has no front image for. */
  key: string | null;
  /** How the release was found: its barcode, an id in its details, or a search on artist and title. */
  via: 'barcode' | 'mbid' | 'search' | null;
  match: Pick<MbRelease, 'release' | 'group' | 'title' | 'credit'> | null;
};

/**
 * A record's cover from the Cover Art Archive — never Discogs' image (ARCH.md §16 #67). Tried in order, lazily, until
 * one is stored: the release with the item's barcode (its own front, else its album's); a MusicBrainz release id in
 * its details; a release search on artist and title, taking only a confident match (pickRelease) and its album's
 * front. `store` fetches a URL into storage — fetchCover()'s rules, which follow the archive's redirect only to
 * archive.org — and answers the new key or null. A failed request is a miss, never a throw.
 */
export async function recordCover(subject: RecordCoverSubject, store: (url: string) => Promise<string | null>): Promise<RecordCoverResult> {
  const tried = new Set<string>();
  const first = async (urls: string[]) => {
    for (const url of urls) {
      if (tried.has(url)) continue;
      tried.add(url);
      const key = await store(url).catch(() => null);
      if (key) return key;
    }
    return null;
  };
  const shown = (r: MbRelease) => ({ release: r.release, group: r.group, title: r.title, credit: r.credit });
  let match: RecordCoverResult['match'] = null;
  let via: RecordCoverResult['via'] = null;

  const digits = subject.barcode?.replace(/\D/g, '') ?? '';
  if (digits.length >= 8) {
    const hit = await releaseByBarcode(digits, subject).catch(() => null);
    if (hit) {
      match = shown(hit);
      via = 'barcode';
      const key = await first([releaseFront(hit.release), ...(hit.group ? [groupFront(hit.group)] : [])]);
      if (key) return { key, via, match };
    }
  }
  if (isMbid(subject.musicbrainzId)) {
    const id = subject.musicbrainzId.toLowerCase();
    match ??= { release: id, group: null, title: subject.title, credit: subject.creators ?? '' };
    via ??= 'mbid';
    const key = await first([releaseFront(id)]);
    if (key) return { key, via: 'mbid', match: { release: id, group: null, title: subject.title, credit: subject.creators ?? '' } };
  }
  const hit = await releaseBySearch(subject).catch(() => null);
  if (hit) {
    match ??= shown(hit);
    via ??= 'search';
    const key = await first([hit.group ? groupFront(hit.group) : releaseFront(hit.release)]);
    if (key) return { key, via: 'search', match: shown(hit) };
  }
  return { key: null, via, match };
}
