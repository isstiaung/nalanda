// Year in review (ARCH.md §16 #59): a year of books finished, pages, authors, tags, ratings and highlights — the
// signed-in member's own beside the household's — and the household's plays of records and games. Counted in SQL, in
// one D1 batch; in the app only, never on share pages or to connections.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { addPastRead, createShare, deleteUser, logPlay, setItemTags, yearInReview } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { clearSharedViewsCache } from '../src/federation/routes';
import app from '../src/index';
import { todayUtc } from '../src/lib/reads';
import { newShareToken } from '../src/lib/share';
import { parseYear, pickerYears } from '../src/lib/yearreview';
import { connectPeer, instanceA, makeKeys, makePeer, setUpA } from './federation-helpers';
import { as, book, member, type Member } from './member-helpers';

const finish = (itemId: number, who: Member | null, endedOn: string | null, beganOn: string | null = null) =>
  addPastRead(env.DB, itemId, { status: 'completed', beganOn, endedOn }, who?.id ?? null);
const rate = (itemId: number, who: Member | null, rating: number) =>
  env.DB.prepare('INSERT INTO reviews (item_id, user_id, rating, rated_at) VALUES (?1, ?2, ?3, datetime())').bind(itemId, who?.id ?? null, rating).run();
const page = async (who: Member | null, path: string) => (await (await as(who, path)).text()).replace(/\s+/g, ' ');
const thisYear = () => Number(todayUtc().slice(0, 4));

describe('books and pages', () => {
  it('counts every finish ending in the year — re-reads again — for me and for the household', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const dune = await book(asha, { title: 'Dune', creators: 'Frank Herbert', length: 600 });
    const kindred = await book(asha, { title: 'Kindred', creators: 'Octavia E. Butler', length: 250 });
    const unmeasured = await book(asha, { title: 'Zine', creators: 'Anon', length: null });
    const record = await book(asha, { title: 'Kind of Blue', mediaType: 'vinyl', length: 45 });
    const game = await book(asha, { title: 'Wingspan', mediaType: 'boardgame' });

    await finish(dune.id, asha, '2025-01-01'); // the first day of the year
    await finish(dune.id, asha, '2025-12-31'); // a re-read, on the last: a finish again, and its pages again
    await finish(kindred.id, ravi, '2025-03-15'); // Ravi's: the household's, not mine
    await finish(unmeasured.id, asha, '2025-03-02'); // a finish, but no pages to add
    await finish(kindred.id, asha, '2024-12-31'); // the year before
    await finish(kindred.id, asha, '2026-01-01'); // the year after
    await finish(kindred.id, asha, null); // undated: in no year
    await addPastRead(env.DB, kindred.id, { status: 'abandoned', beganOn: null, endedOn: '2025-05-01' }, asha.id); // stopped
    await finish(record.id, asha, '2025-03-01'); // a record isn't a book
    await finish(game.id, asha, '2025-03-01'); // nor is a game

    const r = await yearInReview(env.DB, asha.id, 2025);
    expect([r.mine.books, r.mine.pages, r.mine.withLength]).toEqual([3, 1200, 2]);
    expect([r.household.books, r.household.pages, r.household.withLength]).toEqual([4, 1450, 3]);
    expect(r.mine.months.map((m) => m.books)).toEqual([1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(r.household.months.map((m) => m.books)).toEqual([1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(r.household.months.map((m) => m.pages)).toEqual([600, 0, 250, 0, 0, 0, 0, 0, 0, 0, 0, 600]);
    expect(r.undated).toEqual({ mine: 1, household: 1 });

    // Ravi's own year is his one finish; Asha's reads are not his
    const his = await yearInReview(env.DB, ravi.id, 2025);
    expect([his.mine.books, his.mine.pages]).toEqual([1, 250]);
    expect(his.household.books).toBe(4);
    expect(his.undated).toEqual({ mine: 0, household: 1 });

    // the years either side hold their own finish, and nothing of 2025's
    expect((await yearInReview(env.DB, asha.id, 2024)).mine.months.map((m) => m.books)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect((await yearInReview(env.DB, asha.id, 2026)).mine.months.map((m) => m.books)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('counts a book finished twice in one month twice, pages and all', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha, { length: 150 });
    await finish(b.id, asha, '2025-07-01');
    await finish(b.id, asha, '2025-07-30');
    const r = await yearInReview(env.DB, asha.id, 2025);
    expect([r.mine.books, r.mine.pages]).toEqual([2, 300]);
    expect(r.mine.months[6]).toEqual({ books: 2, pages: 300 });
    expect([r.household.books, r.household.pages]).toEqual([2, 300]);
  });

  it('keeps a removed member’s reads in the household, and out of everyone’s own', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const b = await book(asha);
    await finish(b.id, ravi, '2025-06-01');
    await deleteUser(env.DB, ravi.id);
    const r = await yearInReview(env.DB, asha.id, 2025);
    expect([r.mine.books, r.household.books]).toEqual([0, 1]);
    // alone now, but the columns differ, so both show; and a former member's undated finish isn't called hers
    await finish(b.id, null, null);
    const html = await page(asha, '/year-in-review?year=2025');
    expect(html).toContain('<h3>Household</h3>');
    expect(html).toContain('Finished, date unknown: 0 books of yours, 1 in the household');
  });
});

describe('authors and tags', () => {
  it('ranks authors by books read — two editions one book, a re-read one book — and splits co-authors', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const hc = await book(asha, { title: 'Good Omens', creators: 'Terry Pratchett, Neil Gaiman' });
    const pb = await book(asha, { title: 'Good omens ', creators: 'Terry Pratchett, Neil Gaiman' }); // another edition
    const mort = await book(asha, { title: 'Mort', creators: 'Terry Pratchett' });
    const coraline = await book(asha, { title: 'Coraline', creators: 'Neil Gaiman' });
    const mlk = await book(asha, { title: 'Strength to Love', creators: 'Martin Luther King, Jr.' });
    await finish(hc.id, asha, '2025-02-01');
    await finish(pb.id, asha, '2025-03-01');
    await finish(mort.id, asha, '2025-04-01');
    await finish(mort.id, asha, '2025-05-01'); // a re-read
    await finish(mlk.id, asha, '2025-05-02');
    await finish(coraline.id, ravi, '2025-06-01');
    await finish(coraline.id, ravi, '2024-06-01'); // another year

    const r = await yearInReview(env.DB, asha.id, 2025);
    expect(r.mine.authors).toEqual([
      { name: 'Terry Pratchett', books: 2, finishes: 4 },
      { name: 'Neil Gaiman', books: 1, finishes: 2 },
      { name: 'Martin Luther King', books: 1, finishes: 1 },
    ]);
    expect(r.household.authors.slice(0, 2)).toEqual([
      { name: 'Terry Pratchett', books: 2, finishes: 4 }, // level on books, ahead on finishes
      { name: 'Neil Gaiman', books: 2, finishes: 3 },
    ]);
    expect(r.household.authors.map((a) => a.name)).not.toContain('Jr.');
  });

  it('puts two books by one author ahead of one book re-read three times by another', async () => {
    const asha = await member('asha', 'admin');
    const again = await book(asha, { title: 'Comfort', creators: 'Re Reader' });
    const one = await book(asha, { title: 'One', creators: 'Two Books' });
    const two = await book(asha, { title: 'Two', creators: 'Two Books' });
    for (const d of ['2025-01-01', '2025-02-01', '2025-03-01']) await finish(again.id, asha, d);
    await finish(one.id, asha, '2025-04-01');
    await finish(two.id, asha, '2025-05-01');
    expect((await yearInReview(env.DB, asha.id, 2025)).mine.authors).toEqual([
      { name: 'Two Books', books: 2, finishes: 2 },
      { name: 'Re Reader', books: 1, finishes: 3 },
    ]);
    expect(await page(asha, '/year-in-review?year=2025')).toContain('1 book · 3 finishes');
  });

  it('ranks tags by the year’s books carrying them', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const a = await book(asha, { title: 'A', creators: 'X' });
    const a2 = await book(asha, { title: 'A', creators: 'X' }); // A in another edition
    const b = await book(asha, { title: 'B', creators: 'Y' });
    const c = await book(asha, { title: 'C', creators: 'Z' });
    await setItemTags(env.DB, a.id, ['sf', 'classic']);
    await setItemTags(env.DB, a2.id, ['sf']);
    await setItemTags(env.DB, b.id, ['sf']);
    await setItemTags(env.DB, c.id, ['poetry', 'classic']);
    await finish(a.id, asha, '2025-01-05');
    await finish(a2.id, asha, '2025-02-05');
    await finish(b.id, asha, '2025-03-05');
    await finish(c.id, ravi, '2025-04-05');
    const r = await yearInReview(env.DB, asha.id, 2025);
    expect(r.mine.tags).toEqual([
      { name: 'sf', books: 2 },
      { name: 'classic', books: 1 },
    ]);
    expect(r.household.tags).toEqual([
      { name: 'sf', books: 2 }, // level with classic on books, ahead on finishes (three to two)
      { name: 'classic', books: 2 },
      { name: 'poetry', books: 1 },
    ]);
  });
});

describe('ratings and highlights', () => {
  it('averages the ratings each reader gave the books they finished — a re-read’s rating once', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const dune = await book(asha, { title: 'Dune' });
    const emma = await book(asha, { title: 'Emma' });
    const ulysses = await book(asha, { title: 'Ulysses' });
    await finish(dune.id, asha, '2025-01-10');
    await finish(dune.id, asha, '2025-08-10'); // a re-read: her 10 counts once
    await finish(emma.id, asha, '2025-02-10');
    await finish(emma.id, ravi, '2025-02-11');
    await finish(ulysses.id, asha, '2024-02-10'); // last year's book
    await rate(dune.id, asha, 10);
    await rate(emma.id, asha, 4);
    await rate(emma.id, ravi, 8);
    await rate(dune.id, ravi, 2); // Ravi didn't finish Dune this year: his rating isn't this year's
    await rate(ulysses.id, asha, 6); // nor is a rating of a book finished another year

    const r = await yearInReview(env.DB, asha.id, 2025);
    expect(r.mine.rating).toEqual({ average: 7, count: 2 });
    expect(r.household.rating).toEqual({ average: 22 / 3, count: 3 });
    expect(r.mine.topRated.map((b) => [b.title, b.rating])).toEqual([
      ['Dune', 10],
      ['Emma', 4],
    ]);
    expect(r.household.topRated.map((b) => [b.title, b.rating])).toEqual([
      ['Dune', 10],
      ['Emma', 6], // Asha's 4 and Ravi's 8
    ]);
    expect((await yearInReview(env.DB, ravi.id, 2025)).mine.rating).toEqual({ average: 8, count: 1 });
  });

  it('finds the longest and shortest book with a length, and the fastest read, both days counted', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const tome = await book(asha, { title: 'Tome', length: 1200 });
    const slim = await book(asha, { title: 'Slim', length: 90 });
    const blank = await book(asha, { title: 'No length', length: null });
    const quick = await book(asha, { title: 'Quick', length: 200 });
    await finish(tome.id, asha, '2025-03-30', '2025-01-01');
    await finish(slim.id, asha, '2025-04-03', '2025-04-01'); // three days
    await finish(blank.id, asha, '2025-05-01', '2025-05-02'); // ends before it starts: no pace
    await finish(quick.id, asha, '2025-06-01'); // no start: no pace
    await finish(quick.id, ravi, '2025-07-09', '2025-07-09'); // Ravi, in a day
    await finish(tome.id, ravi, '2025-01-05', '2024-12-20'); // begun last year, finished in this one: 17 days

    const r = await yearInReview(env.DB, asha.id, 2025);
    expect(r.mine.longest).toMatchObject({ title: 'Tome', length: 1200 });
    expect(r.mine.shortest).toMatchObject({ title: 'Slim', length: 90 });
    expect(r.mine.fastest).toMatchObject({ title: 'Slim', days: 3 });
    expect(r.household.fastest).toMatchObject({ title: 'Quick', days: 1 });
    expect((await yearInReview(env.DB, ravi.id, 2025)).mine.fastest).toMatchObject({ title: 'Quick', days: 1 });

    const html = await page(asha, '/year-in-review?year=2025');
    expect(html).toContain('in 3 days');
    expect(html).toContain('in a day');
  });
});

describe('records and games', () => {
  it('counts the household’s plays in the year, by type, with the most played of each', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const blue = await book(asha, { title: 'Kind of Blue', mediaType: 'vinyl' });
    const abbey = await book(asha, { title: 'Abbey Road', mediaType: 'vinyl' });
    const wingspan = await book(asha, { title: 'Wingspan', mediaType: 'boardgame' });
    const retyped = await book(asha, { title: 'Was a record', mediaType: 'vinyl' });
    for (const d of ['2025-01-01', '2025-02-01', '2025-12-31']) await logPlay(env.DB, blue.id, d, asha.id);
    await logPlay(env.DB, abbey.id, '2025-06-01', ravi.id);
    await logPlay(env.DB, abbey.id, '2024-12-31', ravi.id); // the year before
    await logPlay(env.DB, abbey.id, '2026-01-01', ravi.id); // the year after
    await logPlay(env.DB, wingspan.id, '2025-03-03', ravi.id);
    await logPlay(env.DB, retyped.id, '2025-03-03', ravi.id);
    await env.DB.prepare("UPDATE items SET media_type = 'music' WHERE id = ?1").bind(retyped.id).run(); // not a record any more

    const r = await yearInReview(env.DB, asha.id, 2025);
    expect(r.plays.vinyl).toEqual({
      plays: 4,
      items: 2,
      top: [
        { id: blue.id, title: 'Kind of Blue', plays: 3 },
        { id: abbey.id, title: 'Abbey Road', plays: 1 },
      ],
    });
    expect(r.plays.boardgame).toEqual({ plays: 1, items: 1, top: [{ id: wingspan.id, title: 'Wingspan', plays: 1 }] });
    // the household's, whoever pressed Played: the same for Ravi
    expect((await yearInReview(env.DB, ravi.id, 2025)).plays).toEqual(r.plays);

    const html = await page(asha, '/year-in-review?year=2025');
    expect(html).toContain('The household’s play log');
    expect(html.match(/Records and games/g)).toHaveLength(1); // shown once, not per column
    expect(html).toContain('No book finished with a date in 2025.'); // plays but no reading

    const noPlays = await yearInReview(env.DB, asha.id, 2023);
    expect(noPlays.plays).toEqual({ vinyl: { plays: 0, items: 0, top: [] }, boardgame: { plays: 0, items: 0, top: [] } });
  });

  it('says so when a year has reading but no plays', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha);
    await finish(b.id, asha, '2025-04-04');
    const html = await page(asha, '/year-in-review?year=2025');
    expect(html).toContain('No records spun in 2025.');
    expect(html).toContain('No games played in 2025.');
  });
});

describe('the page', () => {
  it('shows my year beside the household’s, with a labelled year picker of the years with data and this one', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const b = await book(asha, { title: 'Dune', creators: 'Frank Herbert' });
    await finish(b.id, asha, '2021-05-05');
    await finish(b.id, ravi, '2019-05-05');
    const game = await book(asha, { title: 'Go', mediaType: 'boardgame' });
    await logPlay(env.DB, game.id, '2017-01-01', asha.id);

    const html = await page(asha, '/year-in-review?year=2021');
    expect(html).toContain('<h1>Year in review</h1>');
    expect(html).toContain('<label for="yr-year">Year</label>');
    expect(html).toContain('<select id="yr-year" name="year">');
    const options = [...html.matchAll(/<option value="(\d+)"( selected="")?>/g)].map((m) => [m[1], !!m[2]]);
    const years = [thisYear(), 2021, 2019, 2017].sort((a, b) => b - a);
    expect(options).toEqual(years.map((y) => [String(y), y === 2021]));
    expect(html).toContain('<h3>You</h3>');
    expect(html).toContain('<h3>Household</h3>');
    for (const h of ['Books and pages', 'Authors and tags', 'Ratings and highlights', 'Records and games']) {
      expect(html).toMatch(new RegExp(`<h2 class="eyebrow" id="yr-[a-z]+">${h}</h2>`));
    }
    // no ?year, or a year that isn't one: this year
    expect(await page(asha, '/year-in-review')).toContain(`<option value="${thisYear()}" selected="">`);
    expect(await page(asha, '/year-in-review?year=21')).toContain(`<option value="${thisYear()}" selected="">`);
    expect([parseYear('2025'), parseYear('0999'), parseYear('20251'), parseYear('abcd'), parseYear(undefined), parseYear('9999')]).toEqual([2025, null, null, null, null, null]);
    expect(pickerYears([2021, 2019], 2026, 1990)).toEqual([2026, 2021, 2019, 1990]);
  });

  it('gives the chart a text alternative: the bars hidden, a table of every month read instead', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha, { length: 320 });
    await finish(b.id, asha, '2025-03-03');
    await finish(b.id, asha, '2025-03-20');
    await finish(b.id, asha, '2025-11-01');
    const html = await page(asha, '/year-in-review?year=2025');
    expect(html).toContain('<div class="yr-bars" aria-hidden="true">');
    expect(html).toContain('<figure class="yr-chart" aria-labelledby="yr-chart-mine">');
    const table = html.slice(html.indexOf('<div class="visually-hidden"><table>'), html.indexOf('</table>') + 8);
    expect(table).toContain('<caption>You: books finished and pages read in each month of 2025</caption>');
    expect(table).toContain('<th scope="col">Month</th><th scope="col">Books finished</th><th scope="col">Pages read</th>');
    const monthRows = [...table.matchAll(/<tr><th scope="row">(\w+)<\/th><td>(\d+)<\/td><td>(\d+)<\/td><\/tr>/g)].map((m) => [m[1], m[2], m[3]]);
    expect(monthRows).toHaveLength(12);
    expect(monthRows[0]).toEqual(['January', '0', '0']);
    expect(monthRows[2]).toEqual(['March', '2', '640']);
    expect(monthRows[10]).toEqual(['November', '1', '320']);
    // a household of one gets one column, not the same figures twice
    expect(html).not.toContain('<h3>Household</h3>');
  });

  it('handles an empty year, and a year whose only finishes have no date', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const empty = await page(asha, '/year-in-review?year=2010');
    expect(empty).toContain('Nothing for 2010: no book finished with a date in it, and no plays.');
    expect(empty).not.toContain('yr-chart');
    expect(empty).not.toContain('Finished, date unknown');

    const b = await book(asha);
    await finish(b.id, asha, null);
    await finish(b.id, ravi, null);
    await finish(b.id, ravi, null);
    const undated = await page(asha, `/year-in-review?year=${thisYear()}`);
    expect(undated).toContain(`Nothing yet for ${thisYear()}`);
    expect(undated).toContain('Finished, date unknown: 1 book of yours, 3 in the household — with no end date, they count in no year.');
    expect(await yearInReview(env.DB, asha.id, thisYear())).toMatchObject({ mine: { books: 0 }, household: { books: 0 } });
  });

  it('shows my column empty beside a household that read', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const b = await book(asha);
    await finish(b.id, ravi, '2025-02-02');
    const html = await page(asha, '/year-in-review?year=2025');
    expect(html).toContain('You finished no books with a date in 2025.');
    expect(html).toContain('<caption>Household: books finished and pages read in each month of 2025</caption>');
    expect(html).not.toContain('<caption>You:');
  });
});

describe('privacy: in the app only', () => {
  let peerA: ReturnType<typeof instanceA>;
  beforeEach(async () => {
    peerA = instanceA({ ...env, FEDERATION_PRIVATE_KEY: (await makeKeys()).secret } as Bindings);
    clearSharedViewsCache();
  });

  it('is never on a share page, and a peer or a stranger gets the login page, not the year', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha, { title: 'Secret Reading', length: 777 });
    await finish(b.id, asha, '2025-02-02', '2025-02-01');
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: b.libraryId });

    const shelf = await page(null, `/share/${share.token}`);
    const item = await page(null, `/share/${share.token}/items/${b.id}`);
    for (const html of [shelf, item]) {
      expect(html).toContain('Secret Reading');
      expect(html).not.toContain('year-in-review');
      expect(html).not.toContain('Year in review');
      expect(html).not.toContain('yr-');
    }
    expect((await as(null, `/share/${share.token}/year-in-review`)).status).toBe(404);

    // signed out: to the login page
    const out = await as(null, '/year-in-review?year=2025');
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('/login');

    // a connected household signs its requests but holds no session: the same
    await setUpA();
    const peer = await makePeer('Riverbank library');
    await connectPeer(peer);
    const signed = await peerA.signedGet('/year-in-review?year=2025', peer);
    expect(signed.status).toBe(302);
    expect(await signed.text()).not.toContain('Secret Reading');
    expect((await peerA.signedGet('/federation/year-in-review', peer)).status).toBe(302); // no such route: a page, so the login
  });
});

describe('the D1 budget', () => {
  /** A household with about 2,000 items and 1,500 reads, 600 reviews, 3,000 tag links and 600 plays, spread over years. */
  async function seedLarge(asha: Member, ravi: Member) {
    const shelf = (await env.DB.prepare("INSERT INTO libraries (name) VALUES ('Big') RETURNING id").first<{ id: number }>())!.id;
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
         INSERT INTO items (library_id, media_type, title, creators, length, details)
         SELECT ?1, CASE WHEN i % 10 = 0 THEN 'vinyl' WHEN i % 10 = 5 THEN 'boardgame' ELSE 'book' END,
           'Title ' || i, 'Author ' || (i % 97) || ', Coauthor ' || (i % 13), CASE WHEN i % 7 = 0 THEN NULL ELSE 100 + i % 500 END, '{}'
         FROM n`,
      ).bind(shelf),
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
         INSERT INTO reads (item_id, reader_id, status, began_on, ended_on)
         SELECT (SELECT min(id) FROM items) + (i * 7) % 2000, CASE WHEN i % 3 = 0 THEN ?2 ELSE ?1 END, 'completed',
           date('2023-01-01', '+' || (i % 1000) || ' days'), CASE WHEN i % 50 = 0 THEN NULL ELSE date('2023-01-01', '+' || (i % 1000 + i % 30) || ' days') END
         FROM n`,
      ).bind(asha.id, ravi.id),
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
         INSERT OR IGNORE INTO reviews (item_id, user_id, rating) SELECT (SELECT min(id) FROM items) + (i * 7) % 2000, ?1, 1 + i % 10 FROM n`,
      ).bind(asha.id),
      env.DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) INSERT INTO tags (name) SELECT 'tag' || i FROM n"),
      env.DB.prepare(
        `INSERT OR IGNORE INTO item_tags (item_id, tag_id)
         SELECT i.id, t.id FROM items i JOIN tags t ON (i.id + t.id) % 13 = 0 OR (i.id * t.id) % 17 = 0`,
      ),
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
         INSERT INTO plays (item_id, played_on, logged_by)
         SELECT (SELECT min(id) FROM items) - 1 + (i % 200) * 10 + CASE WHEN i % 2 = 0 THEN 10 ELSE 5 END,
           date('2023-01-01', '+' || (i * 3 % 1000) || ' days'), ?1 FROM n`,
      ).bind(asha.id),
    ]);
  }

  const calls = async (who: Member, path: string) => {
    const budget = { left: 1000 };
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: { cookie: who.cookie } }), { ...env, DB: budgeted(env.DB, budget) }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    await res.text();
    return 1000 - budget.left;
  };

  it('is one D1 call for the whole review, and the page the same few calls on a big catalogue as on none', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const empty = await calls(asha, '/year-in-review?year=2024');

    await seedLarge(asha, ravi);
    const counts = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM reads) AS reads, (SELECT count(*) FROM plays) AS plays, (SELECT count(*) FROM item_tags) AS links",
    ).first<{ items: number; reads: number; plays: number; links: number }>();
    expect(counts).toMatchObject({ items: 2000, reads: 1500, plays: 600 });

    const budget = { left: 1000 };
    const r = await yearInReview(budgeted(env.DB, budget), asha.id, 2024);
    expect(1000 - budget.left).toBe(1); // ten statements, one batch
    expect(r.household.books).toBeGreaterThan(300);
    expect(r.mine.books).toBeLessThan(r.household.books);
    expect(r.plays.vinyl.plays + r.plays.boardgame.plays).toBeGreaterThan(100);
    expect(r.years).toEqual([2025, 2024, 2023]);

    const full = await calls(asha, '/year-in-review?year=2024');
    expect(full).toBe(empty); // however much there is
    expect(full).toBeLessThanOrEqual(4); // the session's, the layout's shelves, and the review's one batch
  });
});
