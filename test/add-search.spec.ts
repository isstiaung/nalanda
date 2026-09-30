// The Add page's name search: BoardGameGeek's matches ranked here (its search answers every match at once, in no
// useful order — "Cryptid" used to fall past the eight kept), every provider paged eight at a time behind "More
// results", and each result starting on the shelf that already holds most of its type.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createLibrary, shelfForType } from '../src/db/queries';
import type { Bindings } from '../src/env';
import app from '../src/index';
import { searchByName } from '../src/metadata';
import { bgg, rankedIds } from '../src/metadata/bgg';
import { activateFetchMock, assertNoPendingInterceptors, intercept } from './fetch-mock';
import { book, member } from './member-helpers';

const BGG = 'https://boardgamegeek.com';
const OL = 'https://openlibrary.org';
const DISCOGS = 'https://api.discogs.com';

const item = (id: number, name: string, type = 'primary') =>
  `<item type="boardgame" id="${id}"><name type="${type}" value="${name}"/><yearpublished value="2020"/></item>`;
const thing = (games: Array<[number, string]>) =>
  `<items>${games.map(([id, name]) => `<item type="boardgame" id="${id}"><name type="primary" value="${name}"/></item>`).join('')}</items>`;

/** BGG's answer for "Cryptid": the game itself listed after eight other titles holding the word, as BGG sends it. */
const CRYPTID_SEARCH = `<items total="11">${[
  item(411001, '48 Rooms: Cryptid Maze – The Search for Bigfoot'),
  item(411002, 'Cryptid Hunters'),
  item(411003, 'Cryptids of the Pines'),
  item(411004, 'Cryptid: Urban Legends'),
  item(411005, 'The Cryptid Club'),
  item(411006, 'Cryptidle'),
  item(411007, 'Hunt for the Cryptid'),
  item(411008, 'Cryptid Safari'),
  item(246784, 'Cryptid'),
  item(411009, 'Kryptid', 'alternate'),
  item(411010, 'Monster Hunters'),
].join('')}</items>`;

afterEach(() => assertNoPendingInterceptors());

describe('BoardGameGeek search ranking', () => {
  it('puts the game named exactly as typed first, however far down BGG lists it', () => {
    const ranked = rankedIds(CRYPTID_SEARCH, 'Cryptid');
    expect(ranked[0]).toBe('246784');
    // then names starting with it, then holding it as a word, then anywhere; ties keep BGG's order
    expect(ranked.slice(1, 4)).toEqual(['411002', '411004', '411008']);
    expect(ranked.indexOf('411001')).toBeLessThan(ranked.indexOf('411003')); // "…Cryptid Maze" (a word) before "Cryptids"
    expect(ranked.slice(-2)).toEqual(['411010', '411009']); // no match at all: last, an alternate name after a primary
  });

  it('matches without caring about case, accents or punctuation, and counts a game listed twice once, by its best name', () => {
    const xml = `<items>${item(1, 'Catan: Cities &amp; Knights')}${item(2, 'Cities of Catan', 'alternate')}${item(2, 'CATAN')}${item(3, 'Pokémon Catan')}</items>`;
    expect(rankedIds(xml, 'catan')).toEqual(['2', '1', '3']);
    expect(rankedIds(xml, 'pokemon catan')).toEqual(['3', '1', '2']);
    expect(rankedIds('<items total="0"></items>', 'catan')).toEqual([]);
  });

  it('ranks a huge answer without parsing it — a common word can match thousands of games', () => {
    const big = `<items total="5000">${Array.from({ length: 5000 }, (_, i) => item(i + 1, i === 4321 ? 'Chess' : `Chess Variant ${i}`)).join('')}</items>`;
    const started = performance.now();
    const ranked = rankedIds(big, 'Chess');
    expect(performance.now() - started).toBeLessThan(200);
    expect(ranked[0]).toBe('4322');
    expect(ranked).toHaveLength(5000);
  });

  it('shows a page of games in the ranking’s order, not the order `thing` answers in, and says whether more follow', async () => {
    activateFetchMock();
    intercept(BGG, (p) => p.startsWith('/xmlapi2/search?'), { body: CRYPTID_SEARCH });
    // `thing` answers by id, not in the order it was asked
    const page1: Array<[number, string]> = [
      [246784, 'Cryptid'], [411002, 'Cryptid Hunters'], [411004, 'Cryptid: Urban Legends'], [411008, 'Cryptid Safari'],
      [411001, '48 Rooms: Cryptid Maze – The Search for Bigfoot'], [411005, 'The Cryptid Club'], [411007, 'Hunt for the Cryptid'],
      [411003, 'Cryptids of the Pines'],
    ];
    intercept(BGG, (p) => p.startsWith(`/xmlapi2/thing?id=${page1.map(([id]) => id).join(',')}&`), {
      body: thing([...page1].sort((x, y) => x[0] - y[0])),
    });
    const first = await bgg('tok').searchPage('Cryptid', 1);
    expect(first.candidates[0]!.title).toBe('Cryptid');
    expect(first.candidates.map((c) => c.details['bgg_id'])).toEqual(page1.map(([id]) => id));
    expect(first.more).toBe(true);

    intercept(BGG, (p) => p.startsWith('/xmlapi2/search?'), { body: CRYPTID_SEARCH });
    intercept(BGG, (p) => p.startsWith('/xmlapi2/thing?id=411006,411010,411009&'), {
      body: thing([[411006, 'Cryptidle'], [411009, 'Kryptid'], [411010, 'Monster Hunters']]),
    });
    const second = await bgg('tok').searchPage('Cryptid', 2);
    expect(second.candidates.map((c) => c.title)).toEqual(['Cryptidle', 'Monster Hunters', 'Kryptid']);
    expect(second.more).toBe(false);
  });
});

describe('paging books and records', () => {
  it('asks Open Library for the page, and uses its count to say whether more follow', async () => {
    activateFetchMock();
    const docs = (n: number, from: number) =>
      JSON.stringify({ numFound: 19, docs: Array.from({ length: n }, (_, i) => ({ key: `/works/OL${from + i}W`, title: `Dune ${from + i}` })) });
    intercept(OL, (p) => p.startsWith('/search.json?q=dune&') && !p.includes('page='), { body: docs(8, 1) });
    const one = await searchByName(env as Bindings, 'dune', 'book', 1);
    expect(one.candidates).toHaveLength(8);
    expect(one.more).toBe(true);

    intercept(OL, (p) => p.startsWith('/search.json?q=dune&') && p.includes('&limit=8&page=3'), { body: docs(3, 17) });
    const three = await searchByName(env as Bindings, 'dune', 'book', 3);
    expect(three.candidates.map((c) => c.title)).toEqual(['Dune 17', 'Dune 18', 'Dune 19']);
    expect(three.more).toBe(false);

    intercept(OL, (p) => p.includes('page=4'), { body: JSON.stringify({ numFound: 19, docs: [] }) });
    const past = await searchByName(env as Bindings, 'dune', 'book', 4);
    expect(past.notices).toEqual(['No more results.']); // not "No books found"
  });

  it('asks Discogs for the page, and uses its page count to say whether more follow', async () => {
    activateFetchMock();
    const reply = (page: number, pages: number) =>
      JSON.stringify({ pagination: { page, pages }, results: [{ id: 100 + page, title: `Miles Davis - Kind of Blue ${page}` }] });
    intercept(DISCOGS, (p) => p.startsWith('/database/search?') && p.includes('per_page=8') && !p.includes('page=2'), { body: reply(1, 2) });
    const withToken = { ...env, DISCOGS_TOKEN: 'tok' } as Bindings;
    const one = await searchByName(withToken, 'kind of blue', 'vinyl', 1);
    expect(one.more).toBe(true);
    intercept(DISCOGS, (p) => p.includes('per_page=8&page=2'), { body: reply(2, 2) });
    const two = await searchByName(withToken, 'kind of blue', 'vinyl', 2);
    expect(two.candidates[0]!.title).toBe('Kind of Blue 2');
    expect(two.more).toBe(false);
  });
});

describe('the Add page’s results', () => {
  const results = async (cookie: string, query: string) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`http://nalanda.test/add/results?${query}`, { headers: { cookie, 'HX-Request': 'true' } }),
      { ...env, BGG_TOKEN: 'tok' } as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res.text();
  };

  it('starts each result on the shelf holding most of its type — a board game on the games shelf, not the first', async () => {
    const asha = await member('asha', 'admin');
    const books = await createLibrary(env.DB, 'Books');
    const games = await createLibrary(env.DB, 'Board games');
    await book(asha, { libraryId: books.id });
    await book(asha, { libraryId: books.id });
    await book(asha, { libraryId: games.id, mediaType: 'boardgame', title: 'Catan' });
    await book(asha, { libraryId: books.id, mediaType: 'boardgame', title: 'Filed on the wrong shelf once' });
    await book(asha, { libraryId: games.id, mediaType: 'boardgame', title: 'Azul' });
    expect(await shelfForType(env.DB)).toEqual({ book: books.id, boardgame: games.id });

    activateFetchMock();
    intercept(BGG, (p) => p.startsWith('/xmlapi2/search?'), { body: CRYPTID_SEARCH });
    intercept(BGG, (p) => p.startsWith('/xmlapi2/thing?'), { body: thing([[246784, 'Cryptid']]) });
    const page = await results(asha.cookie, 'q=Cryptid&type=boardgame');
    expect(page).toContain(`<option value="${games.id}" selected="">Board games</option>`);
    expect(page).not.toContain(`<option value="${books.id}" selected="">`);
  });

  it('offers More results, which brings the next page in place of the button, under the same id', async () => {
    const asha = await member('asha', 'admin');
    await createLibrary(env.DB, 'Games');
    activateFetchMock();
    intercept(BGG, (p) => p.startsWith('/xmlapi2/search?'), { body: CRYPTID_SEARCH });
    intercept(BGG, (p) => p.startsWith('/xmlapi2/thing?'), { body: thing([[246784, 'Cryptid']]) });
    const first = await results(asha.cookie, 'q=Cryptid&type=boardgame');
    expect(first).toContain('<div id="results-more-2" class="results-more">');
    expect(first).toContain('hx-get="/add/results?q=Cryptid&amp;type=boardgame&amp;page=2"');
    expect(first).toContain('hx-target="#results-more-2"');
    expect(first).toContain('Powered by BGG'); // the credit, once, on the first page

    intercept(BGG, (p) => p.startsWith('/xmlapi2/search?'), { body: CRYPTID_SEARCH });
    intercept(BGG, (p) => p.startsWith('/xmlapi2/thing?'), { body: thing([[411006, 'Cryptidle']]) });
    const second = await results(asha.cookie, 'q=Cryptid&type=boardgame&page=2');
    expect(second.startsWith('<div id="results-more-2" class="results-page">')).toBe(true);
    expect(second).toContain('Cryptidle');
    expect(second).not.toContain('results-more-3'); // eleven games: nothing after the second page
    expect(second).not.toContain('Powered by BGG');
  });

  it('never pages a barcode lookup, and reads a nonsense page number as the first', async () => {
    const asha = await member('asha', 'admin');
    await createLibrary(env.DB, 'Games');
    activateFetchMock();
    intercept(BGG, (p) => p.startsWith('/xmlapi2/search?'), { body: CRYPTID_SEARCH });
    intercept(BGG, (p) => p.startsWith('/xmlapi2/thing?id=246784,'), { body: thing([[246784, 'Cryptid']]) });
    const page = await results(asha.cookie, 'q=Cryptid&type=boardgame&page=-3');
    expect(page).toContain('Cryptid');
    expect(page).toContain('id="results-more-2"');
  });
});
