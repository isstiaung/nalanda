// Discogs' API terms want "Data provided by Discogs." directly next to any data from its API, linked to the discogs.com
// page holding that data, without nofollow, and a notice that the app isn't affiliated with Discogs (ARCH.md §16 #63).
// These pin where the credit appears — a record's page, a shared record's page, a connection's record, the Add page's
// Discogs results — where it doesn't (a record typed in by hand, anything that isn't a record), that its link is built
// from a numeric release id only, and that on a share page it adds nothing the page didn't already show.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createItem, createLibrary, createShare, setWant } from '../src/db/queries';
import type { Item, NewItem } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { newShareToken } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import { DISCOGS_NOTICE, discogsLink, discogsUrl } from '../src/views/attribution';
import app from '../src/index';
import { answerOutbound, connectPeer, instanceA, json as peerJson, makeKeys, makePeer, sessionCookie, setUpA } from './federation-helpers';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { SEARCH_BY_BARCODE } from './fixtures/discogs';
import { member, type Member } from './member-helpers';

const CREDIT_TEXT = 'Data provided by Discogs.';
const RELEASE = 'https://www.discogs.com/release/7700123';
/** The whole block, exactly: the credit, linked to the release, and the terms' notice — nothing from the item but its id. */
const BLOCK =
  `<div class="discogs-attribution"><p><a href="${RELEASE}" class="discogs-credit" rel="noreferrer">Data provided by Discogs.` +
  `<span class="visually-hidden"> This release on discogs.com</span></a></p><p class="discogs-notice">${DISCOGS_NOTICE}</p></div>`;

/** Pressing as Discogs fills it (§16 #55): a release id and the fields beside it. */
const PRESSING = {
  discogs_id: 7700123,
  label: 'Harvest, EMI',
  catno: 'SHVL 804',
  country: 'Europe',
  year: 2019,
  format: '2×Vinyl, LP, Album',
  genres: ['Jazz'],
  tracklist: [{ heading: 'Side A' }, { position: 'A1', title: 'First Rain', duration: '7:02' }],
};

async function call(who: Member | null, path: string, token = 'test-discogs-token') {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, { headers: who ? { cookie: who.cookie } : {}, redirect: 'manual' }),
    { ...env, DISCOGS_TOKEN: token } as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
const html = async (who: Member | null, path: string) => {
  clearSharePageCache();
  const res = await call(who, path);
  expect(res.status, path).toBe(200);
  return res.text();
};

async function item(values: Partial<NewItem> & { libraryId: number }): Promise<Item> {
  return createItem(env.DB, { mediaType: 'vinyl', title: 'Monsoon Suites', creators: 'The Hillside Quartet', copies: 1, details: '{}', ...values });
}

async function shelfAndShare() {
  const shelf = await createLibrary(env.DB, 'Records');
  const share = await createShare(env.DB, { token: newShareToken(), name: 'Our records', libraryId: shelf.id });
  return { shelf, token: share.token };
}

/** The hrefs of every discogs.com link on a page. */
const discogsHrefs = (page: string) => [...page.matchAll(/href="(https?:\/\/[^"]*discogs[^"]*)"/g)].map((m) => m[1]!);

/** A connected household's item page, their answer stubbed: a record unless told otherwise. */
async function theirRecord(details: Record<string, unknown>, mediaType = 'vinyl') {
  const keys = await makeKeys();
  const a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
  await setUpA();
  const { id } = await connectPeer(await makePeer('Riverbank library'));
  answerOutbound((req) =>
    new URL(req.url).pathname === '/federation/item'
      ? peerJson({
          id: 70, mediaType, title: 'Their record', creators: null, published: null, coverKey: null, rating: null, inCollection: true,
          available: true, stamp: '0123456789abcdef', publisher: null, description: null, length: null, review: null, details,
          completedOn: null, updatedAt: '2026-09-01 10:00:00', tags: [],
        })
      : peerJson({}, 404),
  );
  return (await a.get(`/households/${id}/views/7/items/70`, await sessionCookie('member'))).text();
}

describe('the rule', () => {
  it('credits a record whose details hold a Discogs release id and something Discogs filled', () => {
    expect(discogsLink({ mediaType: 'vinyl', details: PRESSING })).toBe(RELEASE);
    expect(discogsLink({ mediaType: 'music', details: { discogs_id: 42, format: 'CD' } })).toBe('https://www.discogs.com/release/42');
    // each field Discogs fills is enough on its own, the tracklist and genres included
    for (const k of ['label', 'catno', 'country', 'year', 'format', 'genres', 'tracklist'] as const) {
      expect(discogsLink({ mediaType: 'vinyl', details: { discogs_id: 1, [k]: PRESSING[k] } }), k).toBe('https://www.discogs.com/release/1');
    }
  });

  it('never credits a record typed in by hand, a record with an id and nothing else, or anything that isn’t a record', () => {
    // a manual entry: pressing typed in, but no release id — Discogs didn't supply it
    expect(discogsLink({ mediaType: 'vinyl', details: { label: 'Harvest', catno: 'SHVL 804', year: 2019 } })).toBeNull();
    expect(discogsLink({ mediaType: 'vinyl', details: {} })).toBeNull();
    expect(discogsLink({ mediaType: 'vinyl', details: { discogs_id: 7700123 } })).toBeNull();
    expect(discogsLink({ mediaType: 'vinyl', details: { discogs_id: 7700123, label: '', genres: [], tracklist: [] } })).toBeNull();
    for (const mediaType of ['book', 'boardgame', 'movie'] as const) {
      expect(discogsLink({ mediaType, details: PRESSING }), mediaType).toBeNull();
    }
  });

  it('builds the release link from a positive whole number only, and falls back to discogs.com', () => {
    const link = (discogs_id: unknown) => discogsLink({ mediaType: 'vinyl', details: { discogs_id, label: 'RCA' } });
    expect(link('249504')).toBe('https://www.discogs.com/release/249504'); // digits typed into the details box
    expect(link(' 249504 ')).toBe('https://www.discogs.com/release/249504');
    for (const hostile of [
      '249504"><script>alert(1)</script>',
      'javascript:alert(1)',
      '../../settings',
      '//evil.example',
      '249504/../../x',
      '1e3',
      '-5',
      -5,
      0,
      1.5,
      Number.MAX_SAFE_INTEGER + 2,
      true,
      { id: 1 },
    ]) {
      expect(link(hostile), String(hostile)).toBe('https://www.discogs.com/');
    }
    expect(discogsUrl(undefined)).toBe('https://www.discogs.com/');
  });
});

describe('a record’s page in the app', () => {
  it('credits Discogs right below the pressing, linked to the release, with the notice', async () => {
    const asha = await member('asha', 'admin');
    const { shelf } = await shelfAndShare();
    const lp = await item({ libraryId: shelf.id, details: JSON.stringify(PRESSING) });
    const page = await html(asha, `/items/${lp.id}`);
    expect(page).toContain(BLOCK);
    // inside the pressing section: after the tracklist, before the Refresh button
    const section = page.slice(page.indexOf('<div class="detail-section" id="pressing">'));
    expect(section.indexOf('class="tracklist"')).toBeLessThan(section.indexOf(BLOCK));
    expect(section.indexOf(BLOCK)).toBeLessThan(section.indexOf('Refresh from Discogs'));
    expect(page).not.toMatch(/nofollow/i);
    expect(discogsHrefs(page)).toEqual([RELEASE]);
  });

  it('shows no credit for a record typed in by hand, or one with no pressing', async () => {
    const asha = await member('asha', 'admin');
    const { shelf } = await shelfAndShare();
    const typed = await item({ libraryId: shelf.id, details: JSON.stringify({ label: 'Harvest', catno: 'SHVL 804', year: 2019 }) });
    const bare = await item({ libraryId: shelf.id, title: 'Unknown pressing' });
    for (const lp of [typed, bare]) {
      const page = await html(asha, `/items/${lp.id}`);
      expect(page).not.toContain(CREDIT_TEXT);
      expect(page).not.toContain('discogs.com');
      expect(page).not.toContain('not affiliated');
    }
    // negative control: the hand-typed record does show its pressing, so the credit's absence is the rule at work
    expect(await html(asha, `/items/${typed.id}`)).toContain('<dt>Catalog #</dt><dd>SHVL 804</dd>');
  });

  it('puts the credit below the plain list when that is where a record’s Discogs data is', async () => {
    const asha = await member('asha', 'admin');
    const { shelf } = await shelfAndShare();
    const lp = await item({ libraryId: shelf.id, details: JSON.stringify({ discogs_id: 7700123, genres: ['Jazz'] }) });
    const page = await html(asha, `/items/${lp.id}`);
    expect(page).toContain('No pressing details yet.');
    expect(page.indexOf('<dt>Genres</dt>')).toBeLessThan(page.indexOf(BLOCK));
    expect(page.match(/Data provided by Discogs\./g)).toHaveLength(1);
  });

  it('never lets a hand-typed id into the link', async () => {
    const asha = await member('asha', 'admin');
    const { shelf } = await shelfAndShare();
    const lp = await item({ libraryId: shelf.id, details: JSON.stringify({ discogs_id: '7700123" onmouseover="alert(1)', label: 'RCA' }) });
    const page = await html(asha, `/items/${lp.id}`);
    expect(discogsHrefs(page)).toEqual(['https://www.discogs.com/']);
    expect(page).toContain('<span class="visually-hidden"> Discogs home page</span>');
    expect(page).not.toContain('" onmouseover="alert(1)');
  });
});

describe('a shared record', () => {
  it('credits Discogs beside the public pressing, with the notice, and nofollow nowhere', async () => {
    const { shelf, token } = await shelfAndShare();
    const lp = await item({ libraryId: shelf.id, details: JSON.stringify(PRESSING), mediaCondition: 'NM', sleeveCondition: 'VG+' });
    const page = await html(null, `/share/${token}/items/${lp.id}`);
    expect(page).toContain('<dt>Catalog #</dt><dd>SHVL 804</dd>');
    expect(page).toContain(BLOCK);
    expect(page).not.toMatch(/nofollow/i);
    expect(page).not.toMatch(/target="_blank"/);
    // the share page stays noindex; noindex alone doesn't stop a link being followed
    expect(page).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
  });

  it('adds nothing the page didn’t already show: the id in the link is the Discogs ID it lists, and the rest is fixed text', async () => {
    const { shelf, token } = await shelfAndShare();
    const lp = await item({ libraryId: shelf.id, details: JSON.stringify(PRESSING), mediaCondition: 'NM', sleeveCondition: 'VG+', notes: 'bought in Pune' });
    const page = await html(null, `/share/${token}/items/${lp.id}`);
    expect(page).toContain('<dt>Discogs ID</dt><dd>7700123</dd>');
    // take the credit out, and the page is what it was: every remaining link stays on the share or its assets
    const without = page.replace(BLOCK, '');
    expect(without).not.toContain('discogs.com');
    const hrefs = [...without.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs.filter((h) => !h.startsWith(`/share/${token}`) && h !== '/app.css' && h !== '/logo.svg')).toEqual([]);
    // grades and notes stay private, credit or not
    expect(page).not.toMatch(/Near Mint|VG\+|grade|bought in Pune/);
  });

  it('shows no credit for a shared record typed in by hand, and none on the listing or a want list', async () => {
    const asha = await member('asha', 'admin');
    const { shelf, token } = await shelfAndShare();
    const typed = await item({ libraryId: shelf.id, details: JSON.stringify({ label: 'Harvest', catno: 'SHVL 804' }) });
    const fromDiscogs = await item({ libraryId: shelf.id, title: 'From Discogs', details: JSON.stringify(PRESSING) });
    const typedPage = await html(null, `/share/${token}/items/${typed.id}`);
    expect(typedPage).toContain('<dt>Catalog #</dt><dd>SHVL 804</dd>'); // control: its pressing is public
    expect(typedPage).not.toContain(CREDIT_TEXT);
    expect(typedPage).not.toContain('discogs.com');

    // the listing's cards show no pressing, so no credit — and no release id
    const listing = await html(null, `/share/${token}`);
    expect(listing).toContain('From Discogs');
    expect(listing).not.toContain(CREDIT_TEXT);
    expect(listing).not.toContain('7700123');

    // a want list shows no details at all (§16 #53): no credit, and no release id through one
    await setWant(env.DB, fromDiscogs.id, asha.id, true);
    const gift = await createShare(env.DB, { token: newShareToken(), name: 'Asha wants', libraryId: null, wantUserId: asha.id });
    const giftPage = await html(null, `/share/${gift.token}/items/${fromDiscogs.id}`);
    expect(giftPage).toContain('From Discogs'); // control: it is on the list
    expect(giftPage).not.toContain(CREDIT_TEXT);
    expect(giftPage).not.toContain('7700123');
  });
});

describe('the link back', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is never nofollow, and never opens a new tab — in the app, on a share page, or for a connection', async () => {
    const asha = await member('asha', 'admin');
    const { shelf, token } = await shelfAndShare();
    const lp = await item({ libraryId: shelf.id, details: JSON.stringify(PRESSING) });
    const pages = {
      app: await html(asha, `/items/${lp.id}`),
      share: await html(null, `/share/${token}/items/${lp.id}`),
      connection: await theirRecord({ discogs_id: 7700123, label: 'Harvest, EMI' }),
    };
    for (const [where, page] of Object.entries(pages)) {
      const credit = page.match(/<a [^>]*class="discogs-credit"[^>]*>/)?.[0];
      expect(credit, where).toBeDefined();
      expect(page, where).not.toMatch(/nofollow/i);
      // nor any rel value that withholds ranking credit
      expect(credit, where).toMatch(/ rel="noreferrer"/);
      expect(credit, where).not.toContain('target=');
    }
  });
});

describe('a connected household’s record', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('credits Discogs beside their pressing, linked by the release id they sent', async () => {
    const page = await theirRecord({ discogs_id: 7700123, label: 'Harvest, EMI', catno: 'SHVL 804' });
    expect(page).toContain('<dt>Catalog #</dt><dd>SHVL 804</dd>');
    expect(page).toContain(BLOCK);
    expect(page).not.toMatch(/nofollow/i);
  });

  it('links to discogs.com when their id isn’t a number, and credits nothing without one', async () => {
    const odd = await theirRecord({ discogs_id: '1"><img src=x onerror=alert(1)>', label: 'Harvest' });
    expect(discogsHrefs(odd)).toEqual(['https://www.discogs.com/']);
    expect(odd).not.toContain('<img src=x');
    const typed = await theirRecord({ label: 'Harvest', catno: 'SHVL 804' });
    expect(typed).toContain('SHVL 804'); // control: their pressing shows
    expect(typed).not.toContain(CREDIT_TEXT);
    const game = await theirRecord({ discogs_id: 7700123, label: 'Harvest' }, 'boardgame');
    expect(game).not.toContain(CREDIT_TEXT);
  });
});

describe('the Add page’s Discogs results', () => {
  const DISCOGS = 'https://api.discogs.com';
  beforeEach(() => activateFetchMock());
  afterEach(() => assertNoPendingInterceptors());

  it('credits each Discogs result to its release, and gives the notice once', async () => {
    const asha = await member('asha');
    intercept(DISCOGS, (p) => p.startsWith('/database/search?barcode=0724384260910&type=release'), json(SEARCH_BY_BARCODE));
    const page = await (await call(asha, '/add/results?barcode=0724384260910')).text();
    expect(page).toContain('Monsoon Suites');
    expect(page).toContain(`<small class="candidate-credit"><a href="${RELEASE}" class="discogs-credit" rel="noreferrer">Data provided by Discogs.`);
    expect(page.split(DISCOGS_NOTICE)).toHaveLength(2); // once
    expect(page.indexOf('Monsoon Suites')).toBeLessThan(page.indexOf(DISCOGS_NOTICE));
    expect(page).not.toMatch(/nofollow/i);
  });

  it('credits nothing for a book search', async () => {
    const asha = await member('asha');
    intercept('https://openlibrary.org', (p) => p.startsWith('/search.json?'), json({ docs: [{ title: 'Monsoon: a novel', key: '/works/OL1W' }] }));
    const page = await (await call(asha, '/add/results?q=Monsoon&type=book')).text();
    expect(page).toContain('Monsoon: a novel'); // control: results came back
    expect(page).not.toContain(CREDIT_TEXT);
    expect(page).not.toContain('not affiliated');
  });
});

describe('D1 calls', () => {
  async function count(who: Member | null, path: string) {
    clearSharePageCache();
    const budget = { left: 1000 };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`http://nalanda.test${path}`, { headers: who ? { cookie: who.cookie } : {}, redirect: 'manual' }),
      { ...env, DB: budgeted(env.DB, budget) } as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status, path).toBe(200);
    return 1000 - budget.left;
  }

  it('are the same for a credited record as for a book, in the app and on a share page', async () => {
    const asha = await member('asha', 'admin');
    const { shelf, token } = await shelfAndShare();
    const lp = await item({ libraryId: shelf.id, details: JSON.stringify(PRESSING) });
    const book = await item({ libraryId: shelf.id, mediaType: 'book', title: 'Piranesi' });
    expect(await html(asha, `/items/${lp.id}`)).toContain(CREDIT_TEXT); // it is the credited page being counted
    expect(await count(asha, `/items/${lp.id}`)).toBe(await count(asha, `/items/${book.id}`));
    expect(await count(null, `/share/${token}/items/${lp.id}`)).toBe(await count(null, `/share/${token}/items/${book.id}`));
  });
});
