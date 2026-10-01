// A record's stored cover comes only from the Cover Art Archive, never from Discogs (ARCH.md §16 #67): what an add
// from a Discogs result stores (search, barcode, a held scan), what a typed URL may be, what the cover backfill
// stores, and MusicBrainz's confidence rule and its pace. A wanted recommendation of a record is in
// test/recommend.spec.ts; the one-off that replaces the covers already stored, in test/record-covers-replace.spec.ts.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createItem, createLibrary, getItem } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { scanQueueOwner } from '../src/lib/auth';
import { fetchCover, isDiscogsUrl } from '../src/lib/covers';
import { findCover } from '../src/metadata';
import { pickRelease, recordCover, releaseByBarcode, resetMusicBrainzPacing, type MbRelease } from '../src/metadata/musicbrainz';
import { CandidateCard } from '../src/views/components';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { as, member, rows } from './member-helpers';

const MB = 'https://musicbrainz.org';
const CAA = 'https://coverartarchive.org';
const RELEASE = 'b527f0f7-7735-3c77-add1-09a9e4a20abb';
const GROUP = 'fb3770f6-83fb-32b7-85c4-1f522a92287e';
const DISCOGS_IMAGE = 'https://i.discogs.com/cover/R-7700123.jpeg';
/** The archive's bytes: told apart from anything else a test serves. */
const ARCHIVE_BYTES = new Uint8Array(1500).fill(9);

const release = (over: Record<string, unknown> = {}) => ({
  id: RELEASE,
  title: 'Monsoon Suites',
  barcode: '0724384260910',
  'artist-credit': [{ name: 'The Hillside Quartet' }],
  'release-group': { id: GROUP, 'primary-type': 'Album' },
  ...over,
});

/** The archive's answer to one cover URL, as it really comes: a 307 to archive.org, a 302 to a storage host, the image. */
function archiveServes(path: string) {
  intercept(CAA, path, { status: 307, headers: { location: 'https://archive.org/download/mbid-1/mbid-1-2_thumb500.jpg' } });
  intercept('https://archive.org', '/download/mbid-1/mbid-1-2_thumb500.jpg', {
    status: 302,
    headers: { location: 'http://ia800905.us.archive.org/1/items/mbid-1/mbid-1-2_thumb500.jpg' }, // asked over https regardless
  });
  intercept('https://ia800905.us.archive.org', '/1/items/mbid-1/mbid-1-2_thumb500.jpg', {
    body: new TextDecoder('latin1').decode(ARCHIVE_BYTES),
    headers: { 'content-type': 'image/jpeg' },
  });
}

/** Every URL fetched from here on, on top of the fetch mock. */
function requested(): string[] {
  const urls: string[] = [];
  const mocked = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return mocked(input, init);
  });
  return urls;
}

const isDiscogs = (url: string) => /(^|\.)discogs\.com$/.test(new URL(url).hostname);

async function storedBytes(key: string | null | undefined): Promise<Uint8Array | null> {
  if (!key) return null;
  const object = await env.COVERS.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

beforeEach(() => {
  activateFetchMock();
  resetMusicBrainzPacing();
});
afterEach(() => {
  assertNoPendingInterceptors();
  vi.unstubAllGlobals();
});

const discogsResult = (shelf: number, over: Record<string, string> = {}) => ({
  source: 'discogs',
  libraryId: String(shelf),
  mediaType: 'vinyl',
  title: 'Monsoon Suites',
  creators: 'The Hillside Quartet',
  isbn13: '0724384260910',
  // what a result's form carried before this change, and what a page rendered before it still sends
  coverUrl: DISCOGS_IMAGE,
  details: JSON.stringify({ discogs_id: 7700123, label: 'Harvest' }),
  ...over,
});

const addedId = (res: Response) => Number(res.headers.get('location')!.split('/').pop());

// ---------- adding a record ----------

describe('adding a record from a Discogs result', () => {
  it('stores the Cover Art Archive’s cover for its barcode, and never fetches the image the result showed', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    intercept(MB, (path) => path.startsWith('/ws/2/release/?query=barcode%3A0724384260910%20OR%20barcode%3A724384260910&'), json({ releases: [release()] }));
    archiveServes(`/release/${RELEASE}/front-500`);
    const urls = requested();
    const res = await as(asha, '/items', { body: discogsResult(shelf.id) });
    expect(res.status).toBe(302);
    const item = await getItem(env.DB, addedId(res));
    expect(await storedBytes(item?.coverKey)).toEqual(ARCHIVE_BYTES);
    expect(urls.filter(isDiscogs)).toEqual([]);
    expect(urls.every((u) => ['musicbrainz.org', 'coverartarchive.org', 'archive.org', 'ia800905.us.archive.org'].includes(new URL(u).hostname))).toBe(true);
    expect(urls.filter((u) => u.startsWith('https://ia800905.'))).toHaveLength(1); // the http redirect, asked over https
  });

  it('searches on artist and title when there’s no barcode, and stores the album’s cover', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    intercept(
      MB,
      (path) => path.startsWith(`/ws/2/release/?query=${encodeURIComponent('release:"Monsoon Suites" AND artist:"The Hillside Quartet"')}&`),
      json({ releases: [release({ barcode: null })] }),
    );
    archiveServes(`/release-group/${GROUP}/front-500`);
    const res = await as(asha, '/items', { body: discogsResult(shelf.id, { isbn13: '' }) });
    expect(await storedBytes((await getItem(env.DB, addedId(res)))?.coverKey)).toEqual(ARCHIVE_BYTES);
  });

  it('adds the record with no cover when nothing confident is found — and never falls back to Discogs’ image', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    // the barcode is someone else's, and the search finds the title by another artist
    intercept(MB, (path) => path.includes('barcode'), json({ releases: [release({ barcode: '5012345678900' })] }));
    intercept(MB, (path) => path.includes('artist'), json({ releases: [release({ barcode: null, 'artist-credit': [{ name: 'Another Band' }] })] }));
    const urls = requested();
    const res = await as(asha, '/items', { body: discogsResult(shelf.id) });
    expect(res.status).toBe(302);
    expect((await getItem(env.DB, addedId(res)))?.coverKey).toBeNull();
    expect(urls.filter((u) => !u.startsWith(MB))).toEqual([]); // no image asked for, Discogs' least of all
    expect((await env.COVERS.list()).objects).toHaveLength(0);
  });

  it('follows the archive’s redirect only to the archive', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    intercept(MB, (path) => path.includes('barcode'), json({ releases: [release({ 'release-group': {} })] }));
    intercept(CAA, `/release/${RELEASE}/front-500`, { status: 307, headers: { location: 'https://images.example/cover.jpg' } });
    intercept(MB, (path) => path.includes('artist'), json({ releases: [] }));
    const urls = requested();
    const res = await as(asha, '/items', { body: discogsResult(shelf.id) });
    expect((await getItem(env.DB, addedId(res)))?.coverKey).toBeNull();
    expect(urls.some((u) => u.startsWith('https://images.example/'))).toBe(false);
  });

  it('does the same for a scan held offline, added from the review list', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    intercept(MB, (path) => path.includes('barcode'), json({ releases: [release()] }));
    archiveServes(`/release/${RELEASE}/front-500`);
    const urls = requested();
    const res = await as(asha, '/items', {
      body: { ...discogsResult(shelf.id), scanOwner: await scanQueueOwner(env.SESSION_SECRET, asha) },
      htmx: true,
    });
    expect(res.status).toBe(200);
    const [added] = await rows<{ cover_key: string }>('SELECT cover_key FROM items WHERE title = ?1', 'Monsoon Suites');
    expect(await storedBytes(added?.cover_key)).toEqual(ARCHIVE_BYTES);
    expect(urls.filter(isDiscogs)).toEqual([]);
  });

  it('shows Discogs’ image in the result card, from Discogs, and leaves it out of the form that adds it', async () => {
    const html = String(
      await CandidateCard({
        candidate: { mediaType: 'vinyl', title: 'Monsoon Suites', coverUrl: DISCOGS_IMAGE, details: { discogs_id: 7700123 }, provider: 'discogs' },
        libraries: [],
      }),
    );
    expect(html).toContain(`<img src="${DISCOGS_IMAGE}"`);
    expect(html).toContain('<input type="hidden" name="coverUrl" value=""/>');
    // negative control: another provider's result still carries its cover to the add
    const book = String(
      await CandidateCard({ candidate: { mediaType: 'book', title: 'Piranesi', coverUrl: 'https://covers.openlibrary.org/b/id/1-L.jpg', details: {}, provider: 'openlibrary' }, libraries: [] }),
    );
    expect(book).toContain('<input type="hidden" name="coverUrl" value="https://covers.openlibrary.org/b/id/1-L.jpg"/>');
  });
});

describe('a cover URL typed by hand', () => {
  it('is the person’s own: stored for a record, and nothing is looked up', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    intercept('https://covers.example', '/mine.jpg', { body: 'y'.repeat(900), headers: { 'content-type': 'image/jpeg' } });
    const urls = requested();
    const res = await as(asha, '/items', {
      body: { libraryId: String(shelf.id), mediaType: 'vinyl', title: 'Home Recording', creators: 'Us', coverUrl: 'https://covers.example/mine.jpg' },
    });
    expect(res.status).toBe(302);
    expect((await getItem(env.DB, addedId(res)))?.coverKey).not.toBeNull();
    expect(urls).toEqual(['https://covers.example/mine.jpg']);
  });

  it('is refused, with the reason, when it is Discogs’ image — on the add form and the edit form', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    const urls = requested();
    // the fully qualified spelling, with its trailing dot, names the same host — DNS reads it so, and so does the check
    for (const url of [DISCOGS_IMAGE, 'https://img.discogs.com/abc=/fit-in/600x600/R-1.jpeg', 'https://discogs.com/x.jpg', 'https://i.discogs.com./cover/R-7700123.jpeg', 'https://I.DISCOGS.COM./x.jpg']) {
      const res = await as(asha, '/items', { body: { libraryId: String(shelf.id), mediaType: 'vinyl', title: 'Typed', coverUrl: url } });
      expect(res.status, url).toBe(400);
      const page = await res.text();
      expect(page).toContain('<p class="error" role="alert" id="item-form-error">Discogs’ images can’t be kept as a cover');
      expect(page).toMatch(/<input name="coverUrl" placeholder="https:\/\/…" value="[^"]+" aria-invalid="true" aria-describedby="item-form-error"\/>/);
    }
    expect(await rows('SELECT id FROM items')).toEqual([]);
    const lp = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Held', coverKey: '0e7d3f4a-1111-4222-8333-444455556666' });
    const res = await as(asha, `/items/${lp.id}`, { body: { libraryId: String(shelf.id), mediaType: 'vinyl', title: 'Held', coverUrl: DISCOGS_IMAGE } });
    expect(res.status).toBe(400);
    expect((await getItem(env.DB, lp.id))?.coverKey).toBe('0e7d3f4a-1111-4222-8333-444455556666');
    expect(urls).toEqual([]);
  });

  it('is never fetched from a Discogs host, whatever path asks', async () => {
    const urls = requested();
    for (const url of [DISCOGS_IMAGE, 'https://api-img.discogs.com/x/R-1.jpg', 'http://www.discogs.com/image.jpg', 'https://i.discogs.com./x.jpg']) {
      expect(await fetchCover(url), url).toBeNull();
    }
    expect(urls).toEqual([]);
  });

  it('knows a Discogs host by its name as DNS reads it: case and a trailing dot aside, and never by a look-alike', () => {
    for (const url of ['https://i.discogs.com/abc.jpg', 'https://i.discogs.com./abc.jpg', 'https://I.Discogs.COM./abc.jpg', 'https://discogs.com./x', 'HTTP://DISCOGS.COM/x']) {
      expect(isDiscogsUrl(url), url).toBe(true);
    }
    for (const url of ['https://discogs.com.example/x.jpg', 'https://notdiscogs.com/x.jpg', 'https://example.com/i.discogs.com./x.jpg', 'not a url', '', null, undefined]) {
      expect(isDiscogsUrl(url), String(url)).toBe(false);
    }
  });
});

// ---------- the cover backfill ----------

describe('the cover backfill, for a record', () => {
  it('takes details from Discogs and the cover from the Cover Art Archive alone', async () => {
    intercept('https://api.discogs.com', (path) => path.startsWith('/database/search?barcode=0724384260910'), json({
      results: [{ id: 7700123, title: 'The Hillside Quartet - Monsoon Suites', year: '2019', label: ['Harvest'], cover_image: DISCOGS_IMAGE }],
    }));
    intercept(MB, (path) => path.includes('barcode'), json({ releases: [release()] }));
    const asked: string[] = [];
    const result = await findCover(
      { ...env, DISCOGS_TOKEN: 'test-token' } as Bindings,
      { barcode: '0724384260910', title: 'Monsoon Suites', creators: 'The Hillside Quartet', mediaType: 'vinyl' },
      async (url) => {
        asked.push(url);
        return 'a-new-key';
      },
    );
    expect(asked).toEqual([`${CAA}/release/${RELEASE}/front-500`]);
    expect(result).toMatchObject({ key: 'a-new-key', method: 'barcode', candidate: { publisher: 'Harvest', published: '2019' } });
    expect(result?.candidate?.coverUrl).toBeUndefined();
  });

  it('finds a record’s cover by the MusicBrainz release id in its details, in the in-app run', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    const lp = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Untitled', description: 'A record with a description already.', details: JSON.stringify({ musicbrainz_id: RELEASE.toUpperCase() }) });
    archiveServes(`/release/${RELEASE}/front-500`);
    const res = await as(asha, '/api/backfill-covers', { json: { after: 0 } });
    expect(await res.json()).toMatchObject({ tried: 1, found: 1 });
    expect(await storedBytes((await getItem(env.DB, lp.id))?.coverKey)).toEqual(ARCHIVE_BYTES);
  });

  it('never puts anything but a MusicBrainz id into an archive URL', async () => {
    const urls = requested();
    for (const hostile of ['../../x', 'https://evil.example/x', `${RELEASE}/../../x`, 42]) {
      expect((await recordCover({ title: 'X', musicbrainzId: hostile }, async () => 'k')).key).toBeNull();
    }
    expect(urls).toEqual([]);
  });
});

// ---------- MusicBrainz ----------

describe('a MusicBrainz match', () => {
  const r = (title: string, credit: string, over: Partial<MbRelease> = {}): MbRelease => ({
    release: crypto.randomUUID(),
    group: GROUP,
    title,
    credit,
    barcode: null,
    album: true,
    ...over,
  });
  const nirvana = { title: 'MTV Unplugged In New York', creators: 'Nirvana' };

  it('is taken when title and artist both match, case, punctuation and a bracketed note aside', () => {
    const hit = r('MTV Unplugged in New York', 'Nirvana');
    expect(pickRelease([hit], nirvana)).toBe(hit);
    const remaster = r('Rumours (2004 Remaster)', 'Fleetwood Mac');
    expect(pickRelease([remaster], { title: 'Rumours', creators: 'Fleetwood Mac' })).toBe(remaster);
    expect(pickRelease([r('The Dark Side of the Moon', 'Pink Floyd')], { title: 'Dark Side of the Moon: Immersion', creators: 'Pink Floyd' })).toBeNull();
  });

  it('needs an artist on both sides: a title alone is a guess', () => {
    expect(pickRelease([r('MTV Unplugged in New York', 'Nirvana')], { title: 'MTV Unplugged In New York', creators: '' })).toBeNull();
    expect(pickRelease([r('MTV Unplugged in New York', 'Nirvana')], { title: 'MTV Unplugged In New York', creators: null })).toBeNull();
    expect(pickRelease([r('MTV Unplugged in New York', '')], nirvana)).toBeNull();
  });

  it('refuses the same title by another artist', () => {
    expect(pickRelease([r('MTV Unplugged in New York', 'Alice in Chains')], nirvana)).toBeNull();
  });

  it('refuses a title that only starts the other, which titlesMatch alone would take', () => {
    expect(pickRelease([r('Live at Leeds', 'The Who')], { title: 'Live', creators: 'The Who' })).toBeNull();
    expect(pickRelease([r('Led Zeppelin', 'Led Zeppelin')], { title: 'Led Zeppelin II', creators: 'Led Zeppelin' })).toBeNull();
    const exact = r('Led Zeppelin II', 'Led Zeppelin');
    expect(pickRelease([r('Led Zeppelin', 'Led Zeppelin'), exact], { title: 'Led Zeppelin II', creators: 'Led Zeppelin' })).toBe(exact);
  });

  it('takes the one plain album when matches span release groups, and nothing when that’s ambiguous', () => {
    const album = r('Nevermind', 'Nirvana', { group: '11111111-1111-4111-8111-111111111111' });
    const live = r('Nevermind', 'Nirvana', { group: '22222222-2222-4222-8222-222222222222', album: false });
    expect(pickRelease([live, album], { title: 'Nevermind', creators: 'Nirvana' })).toBe(album);
    const another = r('Nevermind', 'Nirvana', { group: '33333333-3333-4333-8333-333333333333' });
    expect(pickRelease([live, album, another], { title: 'Nevermind', creators: 'Nirvana' })).toBeNull();
    expect(pickRelease([live, r('Nevermind', 'Nirvana', { group: null, album: false })], { title: 'Nevermind', creators: 'Nirvana' })).toBeNull();
  });

  it('by barcode, needs the same code (leading zeros aside) and its title or artist to agree', async () => {
    const subject = { title: 'Monsoon Suites', creators: 'The Hillside Quartet' };
    intercept(MB, (path) => path.includes('barcode'), json({ releases: [release({ barcode: '724384260910' })] }));
    expect((await releaseByBarcode('0724384260910', subject))?.release).toBe(RELEASE);
    resetMusicBrainzPacing();
    intercept(MB, (path) => path.includes('barcode'), json({ releases: [release({ barcode: '0724384260911' })] }));
    expect(await releaseByBarcode('0724384260910', subject)).toBeNull();
    resetMusicBrainzPacing();
    intercept(MB, (path) => path.includes('barcode'), json({ releases: [release({ title: 'Something Else', 'artist-credit': [{ name: 'Someone Else' }] })] }));
    expect(await releaseByBarcode('0724384260910', subject)).toBeNull();
    resetMusicBrainzPacing();
    intercept(MB, (path) => path.includes('barcode'), json({ releases: [release({ title: 'Monsoon Suites (Deluxe)', 'artist-credit': [{ name: 'Someone Else' }] })] }));
    expect((await releaseByBarcode('0724384260910', subject))?.release).toBe(RELEASE); // the title agrees
  });

  it('asks MusicBrainz at most once a second, with the app’s User-Agent', async () => {
    const asked: Array<{ at: number; agent: string | null }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ at: Date.now(), agent: new Headers(init?.headers).get('user-agent') });
      expect(new URL(String(input)).hostname).toBe('musicbrainz.org');
      return new Response(JSON.stringify({ releases: [] }), { headers: { 'content-type': 'application/json' } });
    });
    // a barcode that finds nothing, then a search: two requests in one lookup
    expect((await recordCover({ barcode: '0724384260910', title: 'Monsoon Suites', creators: 'The Hillside Quartet' }, async () => 'k')).key).toBeNull();
    expect(asked).toHaveLength(2);
    expect(asked[1]!.at - asked[0]!.at).toBeGreaterThanOrEqual(950);
    expect(asked.map((a) => a.agent)).toEqual(['nalanda/0.1 (self-hosted personal library)', 'nalanda/0.1 (self-hosted personal library)']);
  });
});
