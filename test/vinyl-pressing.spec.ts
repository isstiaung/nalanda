// A record's pressing details from Discogs (ARCH.md §16 #55): parsed from recorded responses in Discogs' documented
// shapes, filled in when a record is added from a Discogs result, and by "Refresh from Discogs" for one already in
// the catalog — one request per click, filling blanks and never overwriting what's there. Public catalogue data:
// share pages show the pressing and the tracklist; connections get the plain fields, not the tracklist.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView } from '../src/db/federation';
import { applyPressingFill, createItem, createLibrary, createShare, getItem } from '../src/db/queries';
import type { Item, NewItem } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { clearSharedViewsCache } from '../src/federation/routes';
import { fillPressing } from '../src/lib/pressing';
import { newShareToken } from '../src/lib/share';
import { pressingFromRelease, pressingFromSearch } from '../src/metadata/discogs';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import { connectPeer, instanceA, makeKeys, makePeer, setUpA } from './federation-helpers';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { RELEASE_249504, RELEASE_DOUBLE_LP, SEARCH_BY_BARCODE } from './fixtures/discogs';
import { member, type Member } from './member-helpers';

const DISCOGS = 'https://api.discogs.com';
const TOKEN = 'test-discogs-token';
const DOUBLE_LP_TRACKS = [
  { heading: 'Side A' },
  { position: 'A1', title: 'First Rain', duration: '7:02' },
  { position: 'A2', title: 'Kanha', duration: '9:14', artist: 'The Hillside Quartet Feat. R. Iyer' },
  { heading: 'Side B' },
  { position: 'B1', title: 'The Long Monsoon' },
  { position: 'B1a', title: 'Clouds', duration: '4:10' },
  { position: 'B1b', title: 'Downpour', duration: '6:45' },
  { position: 'C1', title: 'Petrichor', duration: '11:30' },
  { position: 'D1', title: 'After' },
];

/** A request as `who`, with a Discogs token unless told otherwise. */
async function call(who: Member | null, path: string, init: { body?: Record<string, string>; token?: string | null } = {}) {
  const headers: Record<string, string> = { origin: 'http://nalanda.test' };
  if (who) headers.cookie = who.cookie;
  if (init.body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, {
      method: init.body ? 'POST' : 'GET',
      headers,
      body: init.body ? new URLSearchParams(init.body).toString() : undefined,
      redirect: 'manual',
    }),
    { ...env, DISCOGS_TOKEN: init.token === null ? '' : (init.token ?? TOKEN) } as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const page = async (who: Member, path: string) => (await call(who, path)).text();

async function record(by: Member, values: Partial<NewItem> = {}): Promise<Item> {
  return createItem(env.DB, {
    libraryId: values.libraryId ?? (await createLibrary(env.DB, 'Records')).id,
    mediaType: 'vinyl',
    title: 'Never Gonna Give You Up',
    creators: 'Rick Astley',
    details: '{}',
    addedBy: by.id,
    ...values,
  });
}

const detailsOf = async (id: number) => JSON.parse((await getItem(env.DB, id))!.details) as Record<string, unknown>;

/** Counts outbound requests through a stub, for the tests that must see exactly how many a click makes. */
function countingFetch(reply: (url: string) => Response | Promise<Response>) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    return reply(url);
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

// ---------- parsing ----------

describe('parsing a release', () => {
  it('reads the documented example release', () => {
    expect(pressingFromRelease(RELEASE_249504)).toEqual({
      discogsId: 249504,
      label: 'RCA',
      firstLabel: 'RCA',
      catno: 'PB 41447',
      country: 'UK',
      year: 1987,
      format: 'Vinyl, 7", Single, 45 RPM',
      genres: ['Electronic', 'Pop'],
      tracklist: [
        { position: 'A', title: 'Never Gonna Give You Up', duration: '3:32' },
        { position: 'B', title: 'Never Gonna Give You Up (Instrumental)', duration: '3:30' },
      ],
    });
  });

  it('reads quantities, free text, several labels, headings, guest artists and index tracks', () => {
    expect(pressingFromRelease(RELEASE_DOUBLE_LP)).toEqual({
      discogsId: 7700123,
      label: 'Harvest, EMI', // Discogs' "(2)" is not part of the name
      firstLabel: 'Harvest',
      catno: 'SHVL 804', // "none" is Discogs saying there isn't one
      country: 'Europe',
      year: 2019,
      format: '2×Vinyl, LP, Album, Reissue, 180 Gram, Red Translucent',
      genres: ['Jazz'],
      tracklist: DOUBLE_LP_TRACKS,
    });
  });

  it('reads a search result: everything but the tracklist', () => {
    expect(pressingFromSearch(SEARCH_BY_BARCODE.results[0]!)).toEqual({
      discogsId: 7700123,
      label: 'Harvest, EMI',
      firstLabel: 'Harvest',
      catno: 'SHVL 804',
      country: 'Europe',
      year: 2019,
      format: 'Vinyl, LP, Album, Reissue, 180 Gram',
      genres: ['Jazz'],
    });
  });

  it('shrugs off what isn’t shaped like a release', () => {
    const junk = { id: -4, year: 0, labels: 'RCA', formats: [null, { qty: '3' }], tracklist: [null, 7, { type_: 'heading' }], genres: 'Pop' };
    expect(pressingFromRelease(junk as never)).toEqual({
      discogsId: undefined,
      label: undefined,
      firstLabel: undefined,
      catno: undefined,
      country: undefined,
      year: undefined,
      format: undefined,
      genres: undefined,
      tracklist: undefined,
    });
  });

  it('caps a tracklist, and a line, at a size a page and a CSV cell can carry', () => {
    const long = { tracklist: Array.from({ length: 900 }, (_, i) => ({ position: `${i}`, title: 'x'.repeat(1000), type_: 'track' })) };
    const tracks = pressingFromRelease(long).tracklist!;
    expect(tracks).toHaveLength(400);
    expect((tracks[0] as { title: string }).title).toHaveLength(300);
  });
});

// ---------- adding ----------

describe('adding a record from Discogs', () => {
  beforeEach(() => activateFetchMock());
  afterEach(() => assertNoPendingInterceptors());

  it('keeps the scanned barcode on the candidate, with the search result’s pressing', async () => {
    const asha = await member('asha', 'admin');
    intercept(DISCOGS, (path) => path.startsWith('/database/search?barcode=0724384260910&type=release'), json(SEARCH_BY_BARCODE));
    const res = await call(asha, '/api/lookup?barcode=0724384260910');
    const { candidates } = (await res.json()) as { candidates: Array<Record<string, unknown>> };
    expect(candidates[0]).toMatchObject({
      title: 'Monsoon Suites',
      creators: 'The Hillside Quartet',
      publisher: 'Harvest',
      isbn13: '0724384260910',
      details: { discogs_id: 7700123, label: 'Harvest, EMI', catno: 'SHVL 804', country: 'Europe', year: 2019, format: 'Vinyl, LP, Album, Reissue, 180 Gram' },
    });
  });

  it('fetches the release once on save and keeps its pressing and tracklist', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    intercept(DISCOGS, '/releases/7700123', json(RELEASE_DOUBLE_LP));
    const res = await call(asha, '/items', {
      body: {
        source: 'discogs',
        libraryId: String(shelf.id),
        mediaType: 'vinyl',
        title: 'Monsoon Suites',
        creators: 'The Hillside Quartet',
        publisher: 'Harvest',
        published: '2019',
        isbn13: '0724384260910',
        details: JSON.stringify({ discogs_id: 7700123, format: 'Vinyl, LP, Album, Reissue, 180 Gram', label: 'Harvest, EMI', catno: 'SHVL 804', country: 'Europe', year: 2019, genres: ['Jazz'] }),
      },
    });
    expect(res.status).toBe(302);
    const id = Number(res.headers.get('location')!.split('/').pop());
    const item = (await getItem(env.DB, id))!;
    expect(JSON.parse(item.details)).toEqual({
      discogs_id: 7700123,
      format: '2×Vinyl, LP, Album, Reissue, 180 Gram, Red Translucent', // the release's fuller answer replaces the search's
      label: 'Harvest, EMI',
      catno: 'SHVL 804',
      country: 'Europe',
      year: 2019,
      genres: ['Jazz'],
      tracklist: DOUBLE_LP_TRACKS,
    });
    expect([item.publisher, item.published, item.length, item.isbn13]).toEqual(['Harvest', '2019', 7, '0724384260910']);
  });

  it('adds the record as the search described it when the release doesn’t come', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    intercept(DISCOGS, '/releases/7700123', { status: 503 });
    const details = JSON.stringify({ discogs_id: 7700123, format: 'Vinyl, LP', label: 'Harvest, EMI' });
    const res = await call(asha, '/items', { body: { source: 'discogs', libraryId: String(shelf.id), mediaType: 'vinyl', title: 'Monsoon Suites', details } });
    expect(res.status).toBe(302);
    const id = Number(res.headers.get('location')!.split('/').pop());
    expect((await getItem(env.DB, id))!.details).toBe(details);
  });

  it('asks Discogs nothing for a form that didn’t come from a Discogs result', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    const seen = countingFetch(() => new Response(JSON.stringify(RELEASE_249504)));
    const body = { libraryId: String(shelf.id), mediaType: 'vinyl', title: 'Typed by hand', details: JSON.stringify({ discogs_id: 249504 }) };
    expect((await call(asha, '/items', { body })).status).toBe(302);
    expect(seen).toEqual([]);
    // negative control: the same form marked as a Discogs result does ask, with the token
    expect((await call(asha, '/items', { body: { ...body, source: 'discogs' } })).status).toBe(302);
    expect(seen).toEqual([{ url: `${DISCOGS}/releases/249504`, auth: `Discogs token=${TOKEN}` }]);
  });
});

// ---------- Refresh from Discogs ----------

describe('Refresh from Discogs', () => {
  it('fetches the release by its stored id, fills what’s blank, and keeps every hand edit', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, {
      publisher: 'My own label line',
      isbn13: '5012394144777',
      details: JSON.stringify({ discogs_id: 249504, format: 'Vinyl, 7", Picture Disc', label: 'RCA Victor (hand-typed)', country: '', notes_on_sleeve: 'signed' }),
    });
    const seen = countingFetch((url) => (url.endsWith('/releases/249504') ? new Response(JSON.stringify(RELEASE_249504)) : new Response('', { status: 500 })));
    const res = await call(asha, `/items/${lp.id}/discogs`, { body: {} });
    expect(res.status).toBe(302);
    expect(seen.map((s) => s.url)).toEqual([`${DISCOGS}/releases/249504`]); // one request, by the release id — not the barcode
    expect(res.headers.get('location')).toBe(`/items/${lp.id}?discogs=filled&f=catno,country,year,genres,tracklist,published,length#pressing`);

    expect(await detailsOf(lp.id)).toEqual({
      discogs_id: 249504,
      format: 'Vinyl, 7", Picture Disc', // hand edits, kept
      label: 'RCA Victor (hand-typed)',
      notes_on_sleeve: 'signed',
      country: 'UK', // blank: filled
      catno: 'PB 41447',
      year: 1987,
      genres: ['Electronic', 'Pop'],
      tracklist: [
        { position: 'A', title: 'Never Gonna Give You Up', duration: '3:32' },
        { position: 'B', title: 'Never Gonna Give You Up (Instrumental)', duration: '3:30' },
      ],
    });
    const after = (await getItem(env.DB, lp.id))!;
    expect([after.publisher, after.published, after.length, after.title, after.creators]).toEqual(['My own label line', '1987', 2, lp.title, lp.creators]);

    const shown = await page(asha, res.headers.get('location')!.split('#')[0]!);
    expect(shown).toContain('Filled from Discogs: catalogue number, country, year, genres, tracklist, published, length.');

    // negative control: the same record without the hand edits takes Discogs' format, label and publisher — so the
    // release above would have written them, and the refresh chose not to
    const plain = await record(asha, { details: JSON.stringify({ discogs_id: 249504 }) });
    await call(asha, `/items/${plain.id}/discogs`, { body: {} });
    expect(await detailsOf(plain.id)).toMatchObject({ format: 'Vinyl, 7", Single, 45 RPM', label: 'RCA' });
    expect((await getItem(env.DB, plain.id))!.publisher).toBe('RCA');
  });

  it('looks a record without a release id up by its barcode, then fetches the tracklist on the next click', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { title: 'Monsoon Suites', isbn13: '0724384260910' });
    const seen = countingFetch((url) =>
      url.includes('/database/search?barcode=0724384260910&type=release')
        ? new Response(JSON.stringify(SEARCH_BY_BARCODE))
        : url.endsWith('/releases/7700123')
          ? new Response(JSON.stringify(RELEASE_DOUBLE_LP))
          : new Response('', { status: 500 }),
    );

    const first = await call(asha, `/items/${lp.id}/discogs`, { body: {} });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain('/database/search?barcode=0724384260910&type=release');
    expect(await detailsOf(lp.id)).toEqual({
      discogs_id: 7700123,
      label: 'Harvest, EMI',
      catno: 'SHVL 804',
      country: 'Europe',
      year: 2019,
      format: 'Vinyl, LP, Album, Reissue, 180 Gram',
      genres: ['Jazz'],
    });
    expect([(await getItem(env.DB, lp.id))!.publisher, (await getItem(env.DB, lp.id))!.published]).toEqual(['Harvest', '2019']);
    expect(first.headers.get('location')).toContain('&via=barcode');
    expect(await page(asha, first.headers.get('location')!.split('#')[0]!)).toContain('Found by barcode — refresh again for the tracklist.');

    const second = await call(asha, `/items/${lp.id}/discogs`, { body: {} });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.url).toBe(`${DISCOGS}/releases/7700123`); // the id the barcode found
    expect(second.headers.get('location')).toBe(`/items/${lp.id}?discogs=filled&f=tracklist,length#pressing`);
    const details = await detailsOf(lp.id);
    expect(details['tracklist']).toEqual(DOUBLE_LP_TRACKS);
    expect(details['format']).toBe('Vinyl, LP, Album, Reissue, 180 Gram'); // already filled by the search: kept
    expect((await getItem(env.DB, lp.id))!.length).toBe(7);

    // a third click has nothing to add, and writes nothing
    const before = (await getItem(env.DB, lp.id))!;
    await env.DB.prepare("UPDATE items SET updated_at = '2000-01-01 00:00:00' WHERE id = ?1").bind(lp.id).run();
    const third = await call(asha, `/items/${lp.id}/discogs`, { body: {} });
    expect(third.headers.get('location')).toBe(`/items/${lp.id}?discogs=nothing#pressing`);
    expect(seen).toHaveLength(3);
    expect({ ...(await getItem(env.DB, lp.id))!, updatedAt: before.updatedAt }).toEqual(before);
    expect((await getItem(env.DB, lp.id))!.updatedAt).toBe('2000-01-01 00:00:00');
  });

  it('promises a tracklist on the next click only when it has a release id to fetch it by', async () => {
    const asha = await member('asha', 'admin');
    // a hand-typed discogs_id that isn't an id: kept (never overwritten), so every refresh goes by barcode
    const lp = await record(asha, { isbn13: '0724384260910', details: JSON.stringify({ discogs_id: 'see sleeve' }) });
    countingFetch(() => new Response(JSON.stringify(SEARCH_BY_BARCODE)));
    const res = await call(asha, `/items/${lp.id}/discogs`, { body: {} });
    expect(res.headers.get('location')).toContain('&via=barcode');
    expect((await detailsOf(lp.id))['discogs_id']).toBe('see sleeve');
    const shown = await page(asha, res.headers.get('location')!.split('#')[0]!);
    expect(shown).toContain('Filled from Discogs: label,');
    expect(shown).not.toContain('refresh again for the tracklist');
  });

  it('says why when Discogs can’t help, and writes nothing', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { details: JSON.stringify({ discogs_id: 249504 }) });
    for (const [status, code] of [
      [429, 'busy'],
      [404, 'not_found'],
      [401, 'refused'],
      [502, 'unavailable'],
    ] as const) {
      countingFetch(() => new Response('{"message": "nope"}', { status }));
      const res = await call(asha, `/items/${lp.id}/discogs`, { body: {} });
      expect(res.headers.get('location')).toBe(`/items/${lp.id}?discogs=${code}#pressing`);
      expect(await detailsOf(lp.id)).toEqual({ discogs_id: 249504 });
    }
    countingFetch(() => {
      throw new TypeError('network down');
    });
    expect((await call(asha, `/items/${lp.id}/discogs`, { body: {} })).headers.get('location')).toContain('discogs=unavailable');
    expect(await page(asha, `/items/${lp.id}?discogs=busy`)).toContain('Discogs is busy — it allows 60 requests a minute.');
  });

  it('asks Discogs nothing without a token, or without a release id or barcode', async () => {
    const asha = await member('asha', 'admin');
    const seen = countingFetch(() => new Response(JSON.stringify(RELEASE_249504)));
    const withId = await record(asha, { details: JSON.stringify({ discogs_id: 249504 }) });
    const bare = await record(asha, { details: JSON.stringify({ discogs_id: 'not a number' }) });

    expect((await call(asha, `/items/${withId.id}/discogs`, { body: {}, token: null })).headers.get('location')).toContain('discogs=notoken');
    expect((await call(asha, `/items/${bare.id}/discogs`, { body: {} })).headers.get('location')).toContain('discogs=nosource');
    expect(seen).toEqual([]);
    // and neither page offers the button
    expect(await (await call(asha, `/items/${withId.id}`, { token: null })).text()).not.toContain('Refresh from Discogs');
    expect(await page(asha, `/items/${bare.id}`)).not.toContain('Refresh from Discogs');
    // negative control: with a token and a release id, the page offers it and a click asks
    expect(await page(asha, `/items/${withId.id}`)).toContain('Refresh from Discogs');
    await call(asha, `/items/${withId.id}/discogs`, { body: {} });
    expect(seen).toHaveLength(1);
  });

  it('is for records only', async () => {
    const asha = await member('asha', 'admin');
    const seen = countingFetch(() => new Response('{}'));
    const book = await record(asha, { mediaType: 'book', details: JSON.stringify({ discogs_id: 249504 }) });
    expect((await call(asha, `/items/${book.id}/discogs`, { body: {} })).status).toBe(400);
    expect(await page(asha, `/items/${book.id}`)).not.toContain('Refresh from Discogs');
    expect(seen).toEqual([]);
  });

  it('writes nothing when the record was saved while Discogs was asked', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { details: JSON.stringify({ discogs_id: 249504 }) });
    countingFetch(async () => {
      // someone saves the record, by hand, while the request is out
      await env.DB.prepare('UPDATE items SET details = ?1 WHERE id = ?2').bind(JSON.stringify({ discogs_id: 249504, country: 'Mine' }), lp.id).run();
      return new Response(JSON.stringify(RELEASE_249504));
    });
    const res = await call(asha, `/items/${lp.id}/discogs`, { body: {} });
    expect(res.headers.get('location')).toBe(`/items/${lp.id}?discogs=changed#pressing`);
    expect(await detailsOf(lp.id)).toEqual({ discogs_id: 249504, country: 'Mine' });
  });

  it('guards its write on every field it read', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { details: JSON.stringify({ discogs_id: 249504 }) });
    const fill = fillPressing(lp, pressingFromRelease(RELEASE_249504), 'gaps');
    for (const stale of [{ details: '{}' }, { publisher: 'Someone' }, { published: '1990' }, { length: 3 }]) {
      expect(await applyPressingFill(env.DB, lp.id, { ...lp, ...stale }, fill)).toBe(false);
    }
    expect((await getItem(env.DB, lp.id))!.details).toBe(lp.details);
    // negative control: with what it read still there, it writes
    expect(await applyPressingFill(env.DB, lp.id, lp, fill)).toBe(true);
    expect(JSON.parse((await getItem(env.DB, lp.id))!.details).country).toBe('UK');
  });

  it('shows a notice from the codes it knows, never from the address', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { details: JSON.stringify({ discogs_id: 249504 }) });
    const shown = await page(asha, `/items/${lp.id}?discogs=%3Cb%3Ehi-there%3C%2Fb%3E&f=%3Cscript%3Ealert(1),constructor,label`);
    expect(shown).not.toContain('hi-there');
    expect(shown).not.toContain('alert(1)');
    expect(shown).not.toContain('class="notice"'); // an unknown code shows no notice at all
    const filled = await page(asha, `/items/${lp.id}?discogs=filled&f=%3Cscript%3Ealert(1),constructor,__proto__,label`);
    expect(filled).toContain('Filled from Discogs: label.');
    expect(filled).not.toContain('alert(1)');
  });
});

// ---------- the record's page ----------

describe('the record’s page', () => {
  it('lists the pressing, and folds the tracklist', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, {
      details: JSON.stringify({ ...pressingDetails(RELEASE_DOUBLE_LP), genres: ['Jazz'] }),
    });
    const html = await page(asha, `/items/${lp.id}`);
    expect(html).toContain('<p class="eyebrow">Pressing</p>');
    expect(html).toMatch(/<dt>Label<\/dt><dd>Harvest, EMI<\/dd>[\s\S]*<dt>Catalog #<\/dt><dd>SHVL 804<\/dd>[\s\S]*<dt>Country<\/dt><dd>Europe<\/dd>/);
    expect(html).toContain('<details class="tracklist"><summary>Tracklist <span class="mono muted">· 7 tracks</span></summary>');
    expect(html).toContain('<li class="track-heading">Side A</li>');
    expect(html).toContain('<span class="track-pos mono">A2</span><span class="track-title">Kanha<span class="track-artist muted"> — The Hillside Quartet Feat. R. Iyer</span></span><span class="track-time mono">9:14</span>');
    expect(html).not.toContain('[object Object]');
    // the rest of details keep their plain list
    expect(html).toMatch(/<p class="eyebrow">Details<\/p><dl class="details-list"><dt>Discogs ID<\/dt><dd>7700123<\/dd><dt>Genres<\/dt><dd>Jazz<\/dd>/);
  });

  it('keeps a hand-typed tracklist that isn’t a list visible, and skips one that is junk', async () => {
    const asha = await member('asha', 'admin');
    const typed = await record(asha, { details: JSON.stringify({ tracklist: 'see the sleeve' }) });
    expect(await page(asha, `/items/${typed.id}`)).toContain('<dt>tracklist</dt><dd>see the sleeve</dd>');
    const junk = await record(asha, { details: JSON.stringify({ tracklist: [1, null, 'x', { foo: 'bar' }] }) });
    const html = await page(asha, `/items/${junk.id}`);
    expect(html).not.toContain('class="tracklist"');
    expect(html).not.toContain('[object Object]');
  });
});

/** A release's pressing as the details it fills. */
function pressingDetails(release: Parameters<typeof pressingFromRelease>[0]) {
  return JSON.parse(fillPressing({ details: '{}', publisher: null, published: null, length: null }, pressingFromRelease(release), 'gaps').details) as Record<string, unknown>;
}

// ---------- outside the app, exactly as decided ----------

describe('outside the app', () => {
  it('shares the pressing and the tracklist', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { title: 'Monsoon Suites', details: JSON.stringify(pressingDetails(RELEASE_DOUBLE_LP)), mediaCondition: 'NM', sleeveCondition: 'VG+' });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Records', libraryId: lp.libraryId });
    clearSharePageCache();
    const res = await call(null, `/share/${share.token}/items/${lp.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const shown of ['<dt>Label</dt><dd>Harvest, EMI</dd>', '<dt>Catalog #</dt><dd>SHVL 804</dd>', '<dt>Country</dt><dd>Europe</dd>', '<dt>Year</dt><dd>2019</dd>', '2×Vinyl, LP, Album, Reissue, 180 Gram, Red Translucent', 'Petrichor', '· 7 tracks']) {
      expect(html).toContain(shown);
    }
    expect(html).not.toContain('Refresh from Discogs'); // an app action, never on a public page
    expect(html).not.toMatch(/grade|Near Mint|Very Good/);

    // a record with no pressing shows no empty section there
    const bare = await record(asha, { libraryId: lp.libraryId, title: 'Unknown pressing' });
    clearSharePageCache();
    expect(await (await call(null, `/share/${share.token}/items/${bare.id}`)).text()).not.toContain('Pressing');
    // negative control: the app's own page does show the empty section, with its way to fill it
    expect(await page(asha, `/items/${bare.id}`)).toContain('No pressing details yet.');
  });

  describe('to connections', () => {
    beforeEach(() => clearSharedViewsCache());

    it('serve the plain pressing fields, and not the tracklist', async () => {
      const keys = await makeKeys();
      const a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
      await setUpA();
      const peer = await makePeer('Riverbank library');
      await connectPeer(peer);
      const view = await createConnectionView(env.DB, { name: 'All', libraryId: null, mediaType: null, status: null, owned: null });
      const asha = await member('asha', 'admin');
      const lp = await record(asha, { title: 'Monsoon Suites', details: JSON.stringify(pressingDetails(RELEASE_DOUBLE_LP)) });

      const detail = (await (await a.signedGet(`/federation/item?view=${view.id}&id=${lp.id}`, peer)).json()) as { details: Record<string, unknown> };
      expect(detail.details).toEqual({
        discogs_id: 7700123,
        label: 'Harvest, EMI',
        catno: 'SHVL 804',
        country: 'Europe',
        year: 2019,
        format: '2×Vinyl, LP, Album, Reissue, 180 Gram, Red Translucent',
      });
      // negative control: the record does hold a tracklist and genres — the connection whitelist left them out
      expect(Object.keys(await detailsOf(lp.id))).toEqual(expect.arrayContaining(['tracklist', 'genres']));
    });
  });
});

// ---------- the D1 budget ----------

describe('D1 calls', () => {
  async function count(who: Member, path: string, body?: Record<string, string>) {
    const budget = { left: 1000 };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`http://nalanda.test${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { cookie: who.cookie, origin: 'http://nalanda.test', ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: body ? new URLSearchParams(body).toString() : undefined,
        redirect: 'manual',
      }),
      { ...env, DISCOGS_TOKEN: TOKEN, DB: budgeted(env.DB, budget) } as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return { status: res.status, calls: 1000 - budget.left };
  }

  it('cost a refresh three calls — the session check, the read, one guarded write — and a failed one two', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { details: JSON.stringify({ discogs_id: 249504 }) });
    countingFetch(() => new Response(JSON.stringify(RELEASE_249504)));
    expect(await count(asha, `/items/${lp.id}/discogs`, {})).toEqual({ status: 302, calls: 3 });
    countingFetch(() => new Response('', { status: 429 }));
    expect(await count(asha, `/items/${lp.id}/discogs`, {})).toEqual({ status: 302, calls: 2 });
  });

  it('cost a record with a long tracklist no more than a book', async () => {
    const asha = await member('asha', 'admin');
    const tracks = Array.from({ length: 400 }, (_, i) => ({ position: `${i + 1}`, title: `Track ${i + 1}`, duration: '3:00' }));
    const lp = await record(asha, { details: JSON.stringify({ discogs_id: 1, label: 'RCA', tracklist: tracks }) });
    const book = await record(asha, { libraryId: lp.libraryId, mediaType: 'book', title: 'Piranesi' });
    const recordPage = await count(asha, `/items/${lp.id}`);
    expect(recordPage.status).toBe(200);
    expect(recordPage.calls).toBe((await count(asha, `/items/${book.id}`)).calls);
  });
});
