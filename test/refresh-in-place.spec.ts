// "Refresh from Discogs" and "Refresh from BGG" in place (ARCH.md §16 #55, #60): one handler, two renders. With htmx
// each answers 200 — whatever the result, since htmx swaps nothing on an error status — with the section's content,
// what else a fill changes out of band, and the result's fixed sentence into the live region that stays on the page.
// Without htmx, the same redirect as before. Discogs and BGG are replayed: test/fixtures/discogs.ts and bgg.ts.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createItem, createLibrary, getItem } from '../src/db/queries';
import type { Item, NewItem } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { resetBggPacing } from '../src/metadata';
import app from '../src/index';
import { activateFetchMock, assertNoPendingInterceptors, intercept } from './fetch-mock';
import { THING_13, THING_NONE } from './fixtures/bgg';
import { RELEASE_249504, SEARCH_BY_BARCODE } from './fixtures/discogs';
import { member, type Member } from './member-helpers';

const DISCOGS = 'https://api.discogs.com';
const BGG = 'https://boardgamegeek.com';
const thing13 = '/xmlapi2/thing?id=13&stats=1';
/** What a provider might send back that must never reach the page: markup, and its own words. */
const PLANTED = '<script>alert("planted")</script> Rate limit exceeded, says the provider';

beforeEach(() => {
  activateFetchMock();
  resetBggPacing();
});
afterEach(() => {
  assertNoPendingInterceptors();
  vi.unstubAllGlobals();
});

type Call = { htmx?: boolean; discogs?: string | null; bgg?: string | null; db?: D1Database; query?: string; body?: Record<string, string> };

/** A POST (or, with no `body`, a GET) as `who`, with both tokens unless told otherwise. */
async function call(who: Member, path: string, init: Call = {}) {
  const headers: Record<string, string> = { origin: 'http://nalanda.test', cookie: who.cookie };
  if (init.body) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (init.htmx) headers['HX-Request'] = 'true';
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, {
      method: init.body ? 'POST' : 'GET',
      headers,
      body: init.body ? new URLSearchParams(init.body).toString() : undefined,
      redirect: 'manual',
    }),
    {
      ...env,
      DISCOGS_TOKEN: init.discogs === null ? '' : (init.discogs ?? 'test-discogs-token'),
      BGG_TOKEN: init.bgg === null ? '' : (init.bgg ?? 'test-bgg-token'),
      ...(init.db ? { DB: init.db } : {}),
    } as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function item(by: Member, values: Partial<NewItem>): Promise<Item> {
  return createItem(env.DB, {
    libraryId: (await createLibrary(env.DB, 'Shelf')).id,
    mediaType: 'vinyl',
    title: 'Never Gonna Give You Up',
    creators: 'Rick Astley',
    details: '{}',
    addedBy: by.id,
    ...values,
  });
}

/** The live region's out-of-band fill, exactly: the sentence and nothing else. */
const oobStatus = (id: string, sentence: string) => `<output id="${id}" hx-swap-oob="innerHTML">${sentence}</output>`;

/** A partial, not a page: 200, no redirect, no document around it. */
async function partial(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('content-type')).toContain('text/html');
  const body = await res.text();
  expect(body).not.toMatch(/<!doctype|<html|<body/i);
  return body;
}

// ---------- Refresh from Discogs ----------

type DiscogsCase = {
  code: string;
  sentence: string;
  /** The record, and what Discogs answers — queued once per request. */
  setUp: (asha: Member) => Promise<Item>;
  reply: (id: number) => void;
  token?: null;
  /** The no-script redirect's query, after `discogs=`. */
  redirect: string;
};

const pressingOf = { discogs_id: 249504 };

const DISCOGS_CASES: DiscogsCase[] = [
  {
    code: 'filled',
    sentence: 'Filled from Discogs: label, catalogue number, country, year, format, genres, tracklist, publisher, published, length.',
    setUp: (a) => item(a, { details: JSON.stringify(pressingOf) }),
    reply: () => intercept(DISCOGS, '/releases/249504', { body: JSON.stringify(RELEASE_249504) }),
    redirect: 'filled&f=label,catno,country,year,format,genres,tracklist,publisher,published,length',
  },
  {
    code: 'filled, by barcode',
    sentence:
      'Filled from Discogs: release id, label, catalogue number, country, year, format, genres, publisher, published. Found by barcode — refresh again for the tracklist.',
    setUp: (a) => item(a, { isbn13: '0724384260910' }),
    reply: () => intercept(DISCOGS, (p) => p.startsWith('/database/search?barcode=0724384260910'), { body: JSON.stringify(SEARCH_BY_BARCODE) }),
    redirect: 'filled&f=discogs_id,label,catno,country,year,format,genres,publisher,published&via=barcode',
  },
  {
    code: 'nothing',
    sentence: 'Discogs had nothing to add: every field it knows is already filled in here.',
    setUp: async (a) => {
      const lp = await item(a, { details: JSON.stringify(pressingOf) });
      intercept(DISCOGS, '/releases/249504', { body: JSON.stringify(RELEASE_249504) });
      expect((await call(a, `/items/${lp.id}/discogs`, { body: {} })).status).toBe(302); // filled first
      return lp;
    },
    reply: () => intercept(DISCOGS, '/releases/249504', { body: JSON.stringify(RELEASE_249504) }),
    redirect: 'nothing',
  },
  {
    code: 'not_found',
    sentence: 'Discogs has no release for this record’s release id or barcode.',
    setUp: (a) => item(a, { details: JSON.stringify(pressingOf) }),
    reply: () => intercept(DISCOGS, '/releases/249504', { status: 404, body: JSON.stringify({ message: PLANTED }) }),
    redirect: 'not_found',
  },
  {
    code: 'busy',
    sentence: 'Discogs is busy — it allows 60 requests a minute. Try again in a minute.',
    setUp: (a) => item(a, { details: JSON.stringify(pressingOf) }),
    reply: () => intercept(DISCOGS, '/releases/249504', { status: 429, body: PLANTED }),
    redirect: 'busy',
  },
  {
    code: 'refused',
    sentence: 'Discogs refused the DISCOGS_TOKEN — it may have been revoked or mistyped.',
    setUp: (a) => item(a, { details: JSON.stringify(pressingOf) }),
    reply: () => intercept(DISCOGS, '/releases/249504', { status: 401, body: JSON.stringify({ message: PLANTED }) }),
    redirect: 'refused',
  },
  {
    code: 'unavailable',
    sentence: 'Discogs didn’t answer. Try again in a moment.',
    setUp: (a) => item(a, { details: JSON.stringify(pressingOf) }),
    reply: () => intercept(DISCOGS, '/releases/249504', { status: 502, body: PLANTED }),
    redirect: 'unavailable',
  },
  {
    code: 'nosource',
    sentence: 'Nothing to look it up by: add its barcode, or its Discogs release id as discogs_id in details.',
    setUp: (a) => item(a, { details: JSON.stringify({ discogs_id: 'see sleeve' }) }),
    reply: () => {},
    redirect: 'nosource',
  },
  {
    code: 'notoken',
    sentence: 'Set the DISCOGS_TOKEN secret to fill pressing details from Discogs.',
    setUp: (a) => item(a, { details: JSON.stringify(pressingOf) }),
    reply: () => {},
    token: null,
    redirect: 'notoken',
  },
];

describe('Refresh from Discogs, in place', () => {
  for (const k of DISCOGS_CASES) {
    it(`answers htmx "${k.code}" with the pressing, the rest out of band, and its sentence — and a plain post as before`, async () => {
      const asha = await member('asha', 'admin');

      const lp = await k.setUp(asha);
      k.reply(lp.id);
      const body = await partial(await call(asha, `/items/${lp.id}/discogs`, { body: {}, htmx: true, discogs: k.token }));
      // the swapped section's id first — the form's hx-target — then the rest out of band
      expect(body.startsWith('<div id="pressing-body">')).toBe(true);
      expect(body).toContain('<div id="pressing-more" hx-swap-oob="true">');
      expect(body).toContain('<div id="item-filled" class="props-group" hx-swap-oob="true">');
      expect(body).toContain(oobStatus('discogs-status', k.sentence));
      expect(body.match(/<output/g)).toHaveLength(1);
      expect(body).not.toContain('planted');
      expect(body).not.toContain('Rate limit exceeded');

      // with script off, the same result is the same redirect it always was
      const again = await k.setUp(asha);
      k.reply(again.id);
      const res = await call(asha, `/items/${again.id}/discogs`, { body: {}, discogs: k.token });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/items/${again.id}?discogs=${k.redirect}#pressing`);
      // and the page it lands on says the same sentence, in the same live region, as the page loads
      const page = await (await call(asha, res.headers.get('location')!.split('#')[0]!, { discogs: k.token })).text();
      expect(page).toContain(`<output id="discogs-status" class="notice refresh-status" aria-live="polite">${k.sentence}</output>`);
    });
  }

  it('answers "changed" when the record was saved while Discogs was asked, and shows it as it was read', async () => {
    const asha = await member('asha', 'admin');
    const lp = await item(asha, { details: JSON.stringify(pressingOf) });
    vi.stubGlobal('fetch', async () => {
      await env.DB.prepare('UPDATE items SET details = ?1 WHERE id = ?2').bind(JSON.stringify({ ...pressingOf, country: 'Mine' }), lp.id).run();
      return new Response(JSON.stringify(RELEASE_249504));
    });
    const body = await partial(await call(asha, `/items/${lp.id}/discogs`, { body: {}, htmx: true }));
    expect(body).toContain(
      oobStatus('discogs-status', 'This record was saved by someone else while Discogs was asked, so nothing was written. Refresh again.'),
    );
    expect(body).not.toContain('PB 41447'); // nothing of Discogs' was written, or shown
    expect(JSON.parse((await getItem(env.DB, lp.id))!.details)).toEqual({ ...pressingOf, country: 'Mine' });
  });

  it('swaps in exactly what the page shows after the fill: the pressing, the rest, and published, publisher, length', async () => {
    const asha = await member('asha', 'admin');
    const lp = await item(asha, { details: JSON.stringify(pressingOf) });
    intercept(DISCOGS, '/releases/249504', { body: JSON.stringify(RELEASE_249504) });
    const body = await partial(await call(asha, `/items/${lp.id}/discogs`, { body: {}, htmx: true }));
    const page = await (await call(asha, `/items/${lp.id}`)).text();

    const main = body.slice(0, body.indexOf('<div id="pressing-more"'));
    expect(main).toContain('<dd>PB 41447</dd>');
    expect(main).toContain('Data provided by Discogs.'); // the credit, below the pressing it credits (§16 #63)
    expect(page).toContain(main);
    const more = body.slice(body.indexOf('<div id="pressing-more"'), body.indexOf('<div id="item-filled"'));
    expect(more).toContain('<dt>Genres</dt>');
    expect(page).toContain(more.replace(' hx-swap-oob="true"', ''));
    const filled = body.slice(body.indexOf('<div id="item-filled"'), body.indexOf('<output'));
    expect(filled).toContain('<dt>Publisher</dt><dd>RCA</dd>');
    expect(filled).toContain('<dt>Published</dt><dd>1987</dd>');
    expect(filled).toContain('<dt>Length</dt><dd class="mono">2 tracks</dd>');
    expect(page).toContain(filled.replace(' hx-swap-oob="true"', ''));
  });

  it('never says anything from the address: the code comes from the handler, not the query', async () => {
    const asha = await member('asha', 'admin');
    const lp = await item(asha, { details: JSON.stringify(pressingOf) });
    intercept(DISCOGS, '/releases/249504', { status: 429 });
    const planted = `discogs=${encodeURIComponent('<b>planted</b>')}&f=${encodeURIComponent('<script>x</script>,label')}&via=barcode`;
    const body = await partial(await call(asha, `/items/${lp.id}/discogs?${planted}`, { body: { discogs: 'filled', f: 'label' }, htmx: true }));
    expect(body).toContain(oobStatus('discogs-status', 'Discogs is busy — it allows 60 requests a minute. Try again in a minute.'));
    expect(body).not.toContain('planted');
    expect(body).not.toContain('<script');
    expect(body).not.toContain('Found by barcode');
  });
});

// ---------- Refresh from BGG ----------

type BggCase = { code: string; sentence: string; setUp: (asha: Member) => Promise<Item>; reply: () => void; token?: null; redirect: string };

const game = (a: Member, details: Record<string, unknown>, values: Partial<NewItem> = {}) =>
  item(a, { mediaType: 'boardgame', title: 'CATAN', creators: 'Klaus Teuber', details: JSON.stringify(details), ...values });

const BGG_CASES: BggCase[] = [
  {
    code: 'filled',
    sentence: 'Filled from BoardGameGeek: min players, max players, min playtime, max playtime, weight, length.',
    setUp: (a) => game(a, { bgg_id: 13 }),
    reply: () => intercept(BGG, thing13, { body: THING_13 }),
    redirect: 'filled&f=players_min,players_max,playtime_min,playtime_max,weight,length',
  },
  {
    code: 'nothing',
    sentence: 'BoardGameGeek had nothing to add: players, playing time and weight are already filled in here.',
    setUp: (a) => game(a, { bgg_id: 13, players_min: 2, players_max: 5, playtime_min: 30, playtime_max: 60, weight: 1.8 }, { length: 60 }),
    reply: () => intercept(BGG, thing13, { body: THING_13 }),
    redirect: 'nothing',
  },
  {
    code: 'not_found',
    sentence: 'BoardGameGeek has no game with this bgg_id.',
    setUp: (a) => game(a, { bgg_id: 13 }),
    reply: () => intercept(BGG, thing13, { body: THING_NONE }),
    redirect: 'not_found',
  },
  {
    code: 'busy',
    sentence: 'BoardGameGeek is busy — it asks apps to wait a few seconds between requests. Try again shortly.',
    setUp: (a) => game(a, { bgg_id: 13 }),
    reply: () => intercept(BGG, thing13, { status: 429, body: PLANTED }),
    redirect: 'busy',
  },
  {
    code: 'refused',
    sentence: 'BoardGameGeek refused the BGG_TOKEN — it may have been revoked or mistyped.',
    setUp: (a) => game(a, { bgg_id: 13 }),
    reply: () => intercept(BGG, thing13, { status: 401, body: PLANTED }),
    redirect: 'refused',
  },
  {
    code: 'unavailable',
    sentence: 'BoardGameGeek didn’t answer. Try again in a moment.',
    setUp: (a) => game(a, { bgg_id: 13 }),
    reply: () => intercept(BGG, thing13, { status: 502, body: PLANTED }),
    redirect: 'unavailable',
  },
  {
    code: 'noid',
    sentence: 'Nothing to look it up by: add its BoardGameGeek id as bgg_id in details.',
    setUp: (a) => game(a, { players_min: 2 }),
    reply: () => {},
    redirect: 'noid',
  },
  {
    code: 'notoken',
    sentence: 'Set the BGG_TOKEN secret to fill game details from BoardGameGeek.',
    setUp: (a) => game(a, { bgg_id: 13 }),
    reply: () => {},
    token: null,
    redirect: 'notoken',
  },
];

describe('Refresh from BGG, in place', () => {
  for (const k of BGG_CASES) {
    it(`answers htmx "${k.code}" with the details, the length out of band, and its sentence — and a plain post as before`, async () => {
      const asha = await member('asha', 'admin');

      const g = await k.setUp(asha);
      k.reply();
      const body = await partial(await call(asha, `/items/${g.id}/bgg`, { body: {}, htmx: true, bgg: k.token }));
      expect(body.startsWith('<div id="game-details">')).toBe(true);
      expect(body).toContain('<div id="item-filled" class="props-group" hx-swap-oob="true">');
      expect(body).toContain(oobStatus('bgg-status', k.sentence));
      expect(body.match(/<output/g)).toHaveLength(1);
      expect(body).not.toContain('planted');
      expect(body).not.toContain('Rate limit exceeded');

      resetBggPacing(); // one refresh per few seconds per isolate: the second request is a different click
      const again = await k.setUp(asha);
      k.reply();
      const res = await call(asha, `/items/${again.id}/bgg`, { body: {}, bgg: k.token });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/items/${again.id}?bgg=${k.redirect}#details`);
      const page = await (await call(asha, res.headers.get('location')!.split('#')[0]!, { bgg: k.token })).text();
      expect(page).toContain(`<output id="bgg-status" class="notice refresh-status" aria-live="polite">${k.sentence}</output>`);
    });
  }

  it('answers "busy" to a second click right away, with no request to BGG — as a 200 that says so', async () => {
    const asha = await member('asha', 'admin');
    const g = await game(asha, { bgg_id: 13 });
    intercept(BGG, thing13, { body: THING_13 });
    await partial(await call(asha, `/items/${g.id}/bgg`, { body: {}, htmx: true }));
    const body = await partial(await call(asha, `/items/${g.id}/bgg`, { body: {}, htmx: true })); // only one interceptor
    expect(body).toContain(oobStatus('bgg-status', 'BoardGameGeek is busy — it asks apps to wait a few seconds between requests. Try again shortly.'));
  });

  it('answers "changed" when the game was saved while BGG was asked', async () => {
    const asha = await member('asha', 'admin');
    const g = await game(asha, { bgg_id: 13 });
    vi.stubGlobal('fetch', async () => {
      await env.DB.prepare('UPDATE items SET details = ?1 WHERE id = ?2').bind(JSON.stringify({ bgg_id: 13, players_min: 5 }), g.id).run();
      return new Response(THING_13);
    });
    const body = await partial(await call(asha, `/items/${g.id}/bgg`, { body: {}, htmx: true }));
    expect(body).toContain(
      oobStatus('bgg-status', 'This game was saved by someone else while BoardGameGeek was asked, so nothing was written. Refresh again.'),
    );
    expect(JSON.parse((await getItem(env.DB, g.id))!.details)).toEqual({ bgg_id: 13, players_min: 5 });
  });

  it('swaps in exactly what the page shows after the fill: the details, and the length', async () => {
    const asha = await member('asha', 'admin');
    const g = await game(asha, { bgg_id: 13 });
    intercept(BGG, thing13, { body: THING_13 });
    const body = await partial(await call(asha, `/items/${g.id}/bgg`, { body: {}, htmx: true }));
    const page = await (await call(asha, `/items/${g.id}`)).text();

    const main = body.slice(0, body.indexOf('<div id="item-filled"'));
    expect(main).toContain('2.29');
    expect(page).toContain(main);
    const filled = body.slice(body.indexOf('<div id="item-filled"'), body.indexOf('<output'));
    expect(filled).toContain('<dt>Length</dt><dd class="mono">120 min play time</dd>');
    expect(page).toContain(filled.replace(' hx-swap-oob="true"', ''));
  });

  it('never says anything from the address', async () => {
    const asha = await member('asha', 'admin');
    const g = await game(asha, { bgg_id: 13 });
    intercept(BGG, thing13, { status: 401 });
    const planted = `bgg=${encodeURIComponent('<b>planted</b>')}&f=${encodeURIComponent('<script>x</script>,weight')}`;
    const body = await partial(await call(asha, `/items/${g.id}/bgg?${planted}`, { body: { bgg: 'filled', f: 'weight' }, htmx: true }));
    expect(body).toContain(oobStatus('bgg-status', 'BoardGameGeek refused the BGG_TOKEN — it may have been revoked or mistyped.'));
    expect(body).not.toContain('planted');
    expect(body).not.toContain('<script');
  });
});

// ---------- the page: forms, targets and live regions ----------

describe('the item page', () => {
  it('gives each Refresh form a target and a live region that are on the page, and a no-script fallback', async () => {
    const asha = await member('asha', 'admin');
    const lp = await item(asha, { details: JSON.stringify(pressingOf) });
    const g = await game(asha, { bgg_id: 13 });
    for (const [id, what, target, status, busy] of [
      [lp.id, 'discogs', 'pressing-body', 'discogs-status', 'Asking Discogs…'],
      [g.id, 'bgg', 'game-details', 'bgg-status', 'Asking BGG…'],
    ] as const) {
      const page = await (await call(asha, `/items/${id}`)).text();
      const form = page.match(new RegExp(`<form method="post" action="/items/${id}/${what}"[^>]*>`))?.[0] ?? '';
      expect(form).toContain(`hx-post="/items/${id}/${what}"`);
      expect(form).toContain(`hx-target="#${target}"`);
      expect(form).toContain('hx-swap="outerHTML"');
      expect(form).toContain('hx-disabled-elt="find button"');
      expect(form).toContain(`data-refresh-status="${status}"`);
      expect(form).toContain(`data-refresh-busy="${busy}"`);
      expect(page).toContain(`<div id="${target}">`);
      // empty until there is something to say, and there from the start
      expect(page).toContain(`<output id="${status}" class="notice refresh-status" aria-live="polite"></output>`);
      expect(page).toContain('<div id="item-filled" class="props-group">');
      // the live region is outside what is swapped: after the swapped block, before the button
      expect(page.indexOf(`<div id="${target}">`)).toBeLessThan(page.indexOf(`<output id="${status}"`));
      expect(page.indexOf(`<output id="${status}"`)).toBeLessThan(page.indexOf(form));
    }
  });

  it('has app.js say "Asking…" while a refresh is out, hand focus back to the button, and say a fixed sentence when it fails', async () => {
    const js = await (await env.ASSETS.fetch('http://nalanda.test/app.js')).text();
    const block = js.slice(js.indexOf('form[data-refresh-status]'));
    expect(block).toContain("'htmx:beforeRequest'");
    expect(block).toContain("'htmx:afterRequest'"); // focus back to the button, which was disabled while it waited
    expect(block).toContain("'htmx:responseError'");
    expect(block).toContain("'htmx:sendError'");
    expect(block).toContain("'Something went wrong — try again.'");
    expect(block).toContain('dataset.refreshBusy');
  });
});

// ---------- the D1 budget ----------

describe('D1 calls', () => {
  async function count(who: Member, path: string, init: Call = {}) {
    const budget = { left: 1000 };
    const res = await call(who, path, { ...init, db: budgeted(env.DB, budget) });
    return { res, calls: 1000 - budget.left };
  }

  it('costs a Discogs refresh in place three calls filled and two failed — fewer than the redirect and the page it replaces', async () => {
    const asha = await member('asha', 'admin');
    const lp = await item(asha, { details: JSON.stringify(pressingOf) });
    const other = await item(asha, { details: JSON.stringify(pressingOf) });

    intercept(DISCOGS, '/releases/249504', { body: JSON.stringify(RELEASE_249504) });
    const inPlace = await count(asha, `/items/${lp.id}/discogs`, { body: {}, htmx: true });
    expect(inPlace.res.status).toBe(200);
    expect(inPlace.calls).toBe(3); // the session, the record, the guarded write

    intercept(DISCOGS, '/releases/249504', { status: 429 });
    expect((await count(asha, `/items/${lp.id}/discogs`, { body: {}, htmx: true })).calls).toBe(2);

    // what it replaces: the redirect, then the whole page
    intercept(DISCOGS, '/releases/249504', { body: JSON.stringify(RELEASE_249504) });
    const post = await count(asha, `/items/${other.id}/discogs`, { body: {} });
    expect(post.res.status).toBe(302);
    const reload = await count(asha, post.res.headers.get('location')!.split('#')[0]!);
    expect(reload.res.status).toBe(200);
    expect(post.calls).toBe(3);
    expect(inPlace.calls).toBeLessThan(post.calls + reload.calls);
    expect(post.calls + reload.calls).toBeGreaterThanOrEqual(inPlace.calls + 5); // far fewer: the page is 5+ more
  });

  it('costs a BGG refresh in place three calls filled and two failed — fewer than the redirect and the page it replaces', async () => {
    const asha = await member('asha', 'admin');
    const g = await game(asha, { bgg_id: 13 });
    const other = await game(asha, { bgg_id: 13 });

    intercept(BGG, thing13, { body: THING_13 });
    const inPlace = await count(asha, `/items/${g.id}/bgg`, { body: {}, htmx: true });
    expect(inPlace.res.status).toBe(200);
    expect(inPlace.calls).toBe(3);

    resetBggPacing();
    intercept(BGG, thing13, { status: 502 });
    expect((await count(asha, `/items/${g.id}/bgg`, { body: {}, htmx: true })).calls).toBe(2);

    resetBggPacing();
    intercept(BGG, thing13, { body: THING_13 });
    const post = await count(asha, `/items/${other.id}/bgg`, { body: {} });
    expect(post.res.status).toBe(302);
    const reload = await count(asha, post.res.headers.get('location')!.split('#')[0]!);
    expect(reload.res.status).toBe(200);
    expect(post.calls).toBe(3);
    expect(post.calls + reload.calls).toBeGreaterThanOrEqual(inPlace.calls + 5);
  });
});
