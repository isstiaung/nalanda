// A board game's weight — BGG's complexity rating — and "Refresh from BGG" (ARCH.md §16 #60): the weight is read from
// the `thing` answer the search already asks for with stats=1 and kept in details; the refresh asks BGG for one game by
// its stored bgg_id, one request per click, and fills only what's blank. BGG is replayed from test/fixtures/bgg.ts.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyGameFill, createItem, createLibrary, getItem } from '../src/db/queries';
import type { Item, NewItem } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { fillGame, weightBand } from '../src/lib/games';
import { resetBggPacing } from '../src/metadata';
import { bgg, parseWeight } from '../src/metadata/bgg';
import app from '../src/index';
import { activateFetchMock, assertNoPendingInterceptors, intercept } from './fetch-mock';
import { SEARCH_CATAN, THING_13, THING_13_278, THING_278_UNWEIGHED, THING_NONE } from './fixtures/bgg';
import { member, type Member } from './member-helpers';

const BGG = 'https://boardgamegeek.com';
const TOKEN = 'test-bgg-token';
const thing13 = '/xmlapi2/thing?id=13&stats=1';

beforeEach(() => {
  activateFetchMock();
  resetBggPacing();
});
afterEach(() => assertNoPendingInterceptors());

/** A request as `who`, with a BGG token unless told otherwise. */
async function call(who: Member, path: string, init: { post?: boolean; token?: string | null; db?: D1Database } = {}) {
  const headers: Record<string, string> = { origin: 'http://nalanda.test', cookie: who.cookie };
  if (init.post) headers['content-type'] = 'application/x-www-form-urlencoded';
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, { method: init.post ? 'POST' : 'GET', headers, body: init.post ? '' : undefined, redirect: 'manual' }),
    { ...env, BGG_TOKEN: init.token === null ? '' : (init.token ?? TOKEN), ...(init.db ? { DB: init.db } : {}) } as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const refresh = (who: Member, id: number, init: { token?: string | null } = {}) => call(who, `/items/${id}/bgg`, { post: true, ...init });

async function game(by: Member, details: Record<string, unknown> | string, values: Partial<NewItem> = {}): Promise<Item> {
  return createItem(env.DB, {
    libraryId: (await createLibrary(env.DB, 'Games')).id,
    mediaType: 'boardgame',
    title: 'CATAN',
    creators: 'Klaus Teuber',
    details: typeof details === 'string' ? details : JSON.stringify(details),
    addedBy: by.id,
    ...values,
  });
}

const detailsOf = async (id: number) => JSON.parse((await getItem(env.DB, id))!.details) as Record<string, unknown>;
const notice = (location: string | null) => new URL(location!, 'http://nalanda.test').searchParams;

// ---------- the weight, from BGG ----------

describe('the weight, from BGG', () => {
  it('reads averageweight from the search’s thing answer, to two decimals, and none for an unweighed game', async () => {
    intercept(BGG, (p) => p.startsWith('/xmlapi2/search?'), { body: SEARCH_CATAN });
    intercept(BGG, '/xmlapi2/thing?id=13,278&stats=1', { body: THING_13_278 });

    const [catan, cards] = await bgg(TOKEN).search('Catan');

    expect(catan!.details).toMatchObject({ bgg_id: 13, players_min: 3, players_max: 4, playtime_min: 60, playtime_max: 120, weight: 2.29 });
    expect(catan!.length).toBe(120);
    // BGG's 0 means nobody voted: no weight at all, and the key leaves the saved JSON
    expect(cards!.details['weight']).toBeUndefined();
    expect(JSON.parse(JSON.stringify(cards!.details))).not.toHaveProperty('weight');
  });

  it('keeps only weights on BGG’s 1–5 scale', () => {
    expect(parseWeight('2.2857')).toBe(2.29);
    expect(parseWeight('1')).toBe(1);
    expect(parseWeight('5')).toBe(5);
    expect(parseWeight('0')).toBeUndefined();
    expect(parseWeight('0.5')).toBeUndefined();
    expect(parseWeight('5.2')).toBeUndefined();
    expect(parseWeight('')).toBeUndefined();
    expect(parseWeight(undefined)).toBeUndefined();
    expect(parseWeight('NaN')).toBeUndefined();
  });

  it('bands weights at 2 and 3: light below 2, medium to below 3, heavy from 3', () => {
    expect([1, 1.5, 1.99].map(weightBand)).toEqual(['light', 'light', 'light']);
    expect([2, 2.29, 2.99].map(weightBand)).toEqual(['medium', 'medium', 'medium']);
    expect([3, 3.9, 5].map(weightBand)).toEqual(['heavy', 'heavy', 'heavy']);
    expect([0, 0.9, 5.1, null, undefined, Number.NaN].map(weightBand)).toEqual([null, null, null, null, null, null]);
  });

  it('labels the weight on the game’s page, beside the other BGG details', async () => {
    const asha = await member('asha', 'admin');
    const item = await game(asha, { bgg_id: 13, weight: 2.29 });
    const page = await (await call(asha, `/items/${item.id}`, { token: null })).text();
    expect(page).toContain('Weight (1–5)');
    expect(page).toContain('2.29');
  });
});

// ---------- Refresh from BGG ----------

describe('Refresh from BGG', () => {
  it('asks BGG for the game by its bgg_id, in exactly one request, and fills the blanks', async () => {
    const asha = await member('asha', 'admin');
    const item = await game(asha, { bgg_id: 13 }, { length: null });
    intercept(BGG, thing13, { body: THING_13 });

    const res = await refresh(asha, item.id);

    expect(res.status).toBe(302);
    const q = notice(res.headers.get('location'));
    expect(q.get('bgg')).toBe('filled');
    expect(q.get('f')).toBe('players_min,players_max,playtime_min,playtime_max,weight,length');
    expect(await detailsOf(item.id)).toEqual({ bgg_id: 13, players_min: 3, players_max: 4, playtime_min: 60, playtime_max: 120, weight: 2.29 });
    expect((await getItem(env.DB, item.id))!.length).toBe(120);
  });

  it('never overwrites a value, whoever put it there — and touches nothing it isn’t for', async () => {
    const asha = await member('asha', 'admin');
    const before = { bgg_id: 13, players_max: 6, playtime_min: 45, weight: 3.1, house_rules: 'no robber', year: 2015 };
    const item = await game(asha, before, { length: 50, title: 'Catan (our copy)', description: 'Hand-written', publisher: 'Mayfair' });
    intercept(BGG, thing13, { body: THING_13 });

    const q = notice((await refresh(asha, item.id)).headers.get('location'));

    expect(q.get('bgg')).toBe('filled');
    expect(q.get('f')).toBe('players_min,playtime_max');
    expect(await detailsOf(item.id)).toEqual({ ...before, players_min: 3, playtime_max: 120 });
    const after = (await getItem(env.DB, item.id))!;
    expect([after.length, after.title, after.description, after.publisher, after.creators, after.coverKey]).toEqual([
      50,
      'Catan (our copy)',
      'Hand-written',
      'Mayfair',
      'Klaus Teuber',
      null,
    ]);
  });

  it('fills a field that was cleared: blank text and null are blanks, zero is a value', async () => {
    const asha = await member('asha', 'admin');
    const item = await game(asha, { bgg_id: '13', players_min: '', players_max: null, playtime_min: 0 }, { length: 120 });
    intercept(BGG, thing13, { body: THING_13 }); // a bgg_id typed as text, as a libib import keeps it, finds it too

    const q = notice((await refresh(asha, item.id)).headers.get('location'));

    expect(q.get('f')).toBe('players_min,players_max,playtime_max,weight');
    expect(await detailsOf(item.id)).toEqual({ bgg_id: '13', players_min: 3, players_max: 4, playtime_min: 0, playtime_max: 120, weight: 2.29 });
  });

  it('says there was nothing to add when everything it fills is filled', async () => {
    const asha = await member('asha', 'admin');
    const full = { bgg_id: 13, players_min: 2, players_max: 5, playtime_min: 30, playtime_max: 60, weight: 1.8 };
    const item = await game(asha, full, { length: 60 });
    const stamp = (await getItem(env.DB, item.id))!.updatedAt;
    intercept(BGG, thing13, { body: THING_13 });

    const q = notice((await refresh(asha, item.id)).headers.get('location'));

    expect(q.get('bgg')).toBe('nothing');
    expect(await detailsOf(item.id)).toEqual(full);
    expect((await getItem(env.DB, item.id))!.updatedAt).toBe(stamp); // nothing written
  });

  it('leaves an unweighed game’s weight blank, and fills the rest', async () => {
    const asha = await member('asha', 'admin');
    const item = await game(asha, { bgg_id: 278 }, { length: 90 });
    intercept(BGG, '/xmlapi2/thing?id=278&stats=1', { body: THING_278_UNWEIGHED });

    const q = notice((await refresh(asha, item.id)).headers.get('location'));

    expect(q.get('f')).toBe('players_min,players_max,playtime_min,playtime_max');
    expect(await detailsOf(item.id)).not.toHaveProperty('weight');
  });

  it('asks nothing of BGG without a bgg_id, or without a token', async () => {
    const asha = await member('asha', 'admin');
    const noId = await game(asha, { players_min: 2 });
    expect(notice((await refresh(asha, noId.id)).headers.get('location')).get('bgg')).toBe('noid');

    const withId = await game(asha, { bgg_id: 13 });
    expect(notice((await refresh(asha, withId.id, { token: null })).headers.get('location')).get('bgg')).toBe('notoken');
    // no interceptor was queued: any request to BGG would have thrown "Unmocked outbound request"
    expect(await detailsOf(withId.id)).toEqual({ bgg_id: 13 });
  });

  it('refuses anything but a board game, and a game that isn’t there', async () => {
    const asha = await member('asha', 'admin');
    const record = await game(asha, { bgg_id: 13 }, { mediaType: 'vinyl' });
    expect((await refresh(asha, record.id)).status).toBe(400);
    expect((await refresh(asha, 99999)).status).toBe(404);
  });

  it('lets one refresh through to BGG every few seconds: a second click right away is “busy”, with no request', async () => {
    const asha = await member('asha', 'admin');
    const item = await game(asha, { bgg_id: 13 });
    intercept(BGG, thing13, { body: THING_13 });

    expect(notice((await refresh(asha, item.id)).headers.get('location')).get('bgg')).toBe('filled');
    // only one interceptor: a second request would throw, and the notice would not be "busy"
    expect(notice((await refresh(asha, item.id)).headers.get('location')).get('bgg')).toBe('busy');
  });

  it('never calls BGG when a game’s page loads, with or without a notice', async () => {
    const asha = await member('asha', 'admin');
    const item = await game(asha, { bgg_id: 13 });
    // no interceptors: any outbound request throws
    const page = await (await call(asha, `/items/${item.id}`)).text();
    expect(page).toContain(`action="/items/${item.id}/bgg"`);
    expect(page).toContain('Refresh from BGG');
    expect((await call(asha, `/items/${item.id}?bgg=filled&f=weight`)).status).toBe(200);
  });

  it('does not offer the button without a bgg_id or a token, and says why', async () => {
    const asha = await member('asha', 'admin');
    const noId = await game(asha, {});
    const page = await (await call(asha, `/items/${noId.id}`)).text();
    expect(page).not.toContain('Refresh from BGG');
    expect(page).toContain('Add its BoardGameGeek id as bgg_id in details');

    const withId = await game(asha, { bgg_id: 13 });
    const noToken = await (await call(asha, `/items/${withId.id}`, { token: null })).text();
    expect(noToken).not.toContain('Refresh from BGG');
    expect(noToken).toContain('Set the BGG_TOKEN secret');
  });

  it('is a game’s only: a book’s page has no BGG button', async () => {
    const asha = await member('asha', 'admin');
    const book = await game(asha, { bgg_id: 13 }, { mediaType: 'book' });
    expect(await (await call(asha, `/items/${book.id}`)).text()).not.toContain('Refresh from BGG');
  });
});

// ---------- BGG's failures, as fixed notices ----------

describe('BGG’s failures', () => {
  const cases: Array<[string, { status?: number; body?: string }, string]> = [
    ['a 401 (the token refused)', { status: 401, body: 'Unauthorized <script>alert(1)</script>' }, 'refused'],
    ['a 429', { status: 429, body: 'Rate limit exceeded' }, 'busy'],
    ['a 503', { status: 503 }, 'busy'],
    ['a 500', { status: 500 }, 'busy'],
    ['a 202 (queued)', { status: 202, body: '<message>Your request for this collection has been accepted</message>' }, 'busy'],
    ['a 403 from BGG’s edge', { status: 403, body: '<html>challenge</html>' }, 'unavailable'],
    ['a 502', { status: 502 }, 'unavailable'],
    ['an answer with no such game', { body: THING_NONE }, 'not_found'],
    ['a game under another id', { body: THING_278_UNWEIGHED }, 'not_found'],
  ];

  for (const [what, reply, code] of cases) {
    it(`maps ${what} to "${code}", and writes nothing`, async () => {
      const asha = await member('asha', 'admin');
      const item = await game(asha, { bgg_id: 13 });
      intercept(BGG, thing13, reply);

      const res = await refresh(asha, item.id);

      expect(res.headers.get('location')).toBe(`/items/${item.id}?bgg=${code}#details`);
      expect(await detailsOf(item.id)).toEqual({ bgg_id: 13 });
    });
  }

  it('shows each code as its own fixed sentence, and nothing from the URL', async () => {
    const asha = await member('asha', 'admin');
    const item = await game(asha, { bgg_id: 13 });
    const seen = async (qs: string) => (await call(asha, `/items/${item.id}?${qs}`)).text();

    expect(await seen('bgg=busy')).toContain('BoardGameGeek is busy');
    expect(await seen('bgg=refused')).toContain('refused the BGG_TOKEN');
    expect(await seen('bgg=not_found')).toContain('has no game with this bgg_id');
    expect(await seen('bgg=changed')).toContain('saved by someone else');

    const planted = await seen(`bgg=${encodeURIComponent('<script>alert(1)</script>')}`);
    expect(planted).not.toContain('alert(1)');
    expect(planted).not.toContain('<p class="notice">'); // an unknown code shows no notice at all
    const filled = await seen(`bgg=filled&f=${encodeURIComponent('<b>x</b>,weight,constructor,__proto__')}`);
    expect(filled).toContain('Filled from BoardGameGeek: weight.');
    expect(filled).not.toContain('<b>x</b>');
    expect(filled).not.toContain('constructor');
    expect(await seen('bgg=toString')).not.toContain('<p class="notice">'); // not Object.prototype's
  });
});

// ---------- the guarded write ----------

describe('the write', () => {
  it('writes only if details and length are still as the refresh read them', async () => {
    const asha = await member('asha', 'admin');
    const item = await game(asha, { bgg_id: 13 }, { length: null });
    const fill = fillGame(item, {
      mediaType: 'boardgame',
      title: 'CATAN',
      details: { players_min: 3, weight: 2.29 },
      length: 120,
      provider: 'bgg',
    });
    // someone saves the game while BGG is asked
    await env.DB.prepare('UPDATE items SET details = ?1 WHERE id = ?2').bind(JSON.stringify({ bgg_id: 13, players_min: 5 }), item.id).run();

    expect(await applyGameFill(env.DB, item.id, item, fill)).toBe(false);
    expect(await detailsOf(item.id)).toEqual({ bgg_id: 13, players_min: 5 });

    const fresh = (await getItem(env.DB, item.id))!;
    expect(await applyGameFill(env.DB, item.id, fresh, fillGame(fresh, { mediaType: 'boardgame', title: 'CATAN', details: { weight: 2.29 }, provider: 'bgg' }))).toBe(true);
    expect(await detailsOf(item.id)).toEqual({ bgg_id: 13, players_min: 5, weight: 2.29 });
  });

  it('leaves details that don’t read as an object alone', () => {
    const fill = fillGame({ details: '[1,2]', length: null }, { mediaType: 'boardgame', title: 'x', details: { weight: 2 }, length: 30, provider: 'bgg' });
    expect(fill.filled).toEqual([]);
    expect(fill.details).toBe('[1,2]');
  });

  it('costs three D1 calls a click: the session, the game, the write', async () => {
    const asha = await member('asha', 'admin');
    const item = await game(asha, { bgg_id: 13 });
    intercept(BGG, thing13, { body: THING_13 });
    const budget = { left: 1000 };
    const res = await call(asha, `/items/${item.id}/bgg`, { post: true, db: budgeted(env.DB, budget) });
    expect(notice(res.headers.get('location')).get('bgg')).toBe('filled');
    expect(1000 - budget.left).toBe(3);
  });
});
