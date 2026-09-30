// "What should we play tonight?" (ARCH.md §16 #60): players, time and weight filter the household's board games — the
// ones here, in the collection and not all out on loan — in SQL over their details; what fits comes in random order,
// what can't be judged for lack of a detail comes in its own group, and "Pick one for us" draws one that fits. In the
// app only, one D1 call for the results, and never a request to BGG.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary, createShare, gamesForTonight, logPlay, pickGameForTonight } from '../src/db/queries';
import type { Item, NewItem } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { parseGameFilters, type GameFilters } from '../src/lib/games';
import { newShareToken } from '../src/lib/share';
import app from '../src/index';
import { as, html, member, rows, type Member } from './member-helpers';

const ANY: GameFilters = { players: null, minutes: null, weight: null };
const f = (over: Partial<GameFilters>): GameFilters => ({ ...ANY, ...over });

let shelf: number | null = null;
async function game(by: Member, title: string, details: Record<string, unknown> | string, values: Partial<NewItem> = {}): Promise<Item> {
  shelf ??= (await createLibrary(env.DB, 'Board games')).id;
  return createItem(env.DB, {
    libraryId: shelf,
    mediaType: 'boardgame',
    title,
    length: null,
    details: typeof details === 'string' ? details : JSON.stringify(details),
    addedBy: by.id,
    ...values,
  });
}

/**
 * The household's games: three fully described, one light and short with only a single player count, one with nothing
 * at all, one whose details a libib import left as text, and three that aren't here tonight in some way.
 */
async function household() {
  shelf = null;
  const asha = await member('asha', 'admin');
  const g = {
    ticket: await game(asha, 'Ticket to Ride', { bgg_id: 9209, players_min: 2, players_max: 5, playtime_min: 30, playtime_max: 60, weight: 1.83 }),
    catan: await game(asha, 'CATAN', { bgg_id: 13, players_min: 3, players_max: 4, playtime_min: 60, playtime_max: 120, weight: 2.29 }),
    brass: await game(asha, 'Brass: Birmingham', { players_min: 2, players_max: 4, playtime_min: 60, playtime_max: 120, weight: 3.87 }),
    duel: await game(asha, 'Duel for two', { players_min: 2, playtime_max: 20 }), // no max players, no weight
    blank: await game(asha, 'A game with no details', {}),
    libib: await game(asha, 'Imported from libib', { players_min: '2', players_max: ' 6 ', playtime_max: '40', weight: '1.9' }),
    // not here tonight: out on loan, not in the collection, and the book that isn't a game
    lent: await game(asha, 'Lent to Ravi', { players_min: 2, players_max: 4, playtime_max: 30, weight: 1.5 }),
    notOwned: await game(asha, 'Played at a friend’s', { players_min: 2, players_max: 4, playtime_max: 30, weight: 1.5 }, { copies: 0 }),
    book: await game(asha, 'A book about games', { players_min: 2, players_max: 4, playtime_max: 30, weight: 1.5 }, { mediaType: 'book' }),
    // two copies, one of them lent: still one to play
    twoCopies: await game(asha, 'Codenames', { players_min: 2, players_max: 8, playtime_max: 15, weight: 1.27 }, { copies: 2 }),
  };
  await env.DB.prepare("INSERT INTO loans (item_id, borrower, loaned_on) VALUES (?1, 'Ravi', '2026-09-01'), (?2, 'Meera', '2026-09-01')")
    .bind(g.lent.id, g.twoCopies.id)
    .run();
  return { asha, g };
}

const titles = (list: Array<{ title: string }>) => list.map((x) => x.title).sort();

// ---------- the filters ----------

describe('the filters', () => {
  it('with none set, lists every game that is here — none of the lent, the not owned, or anything not a game', async () => {
    const { g } = await household();
    const r = await gamesForTonight(env.DB, ANY, 60);
    expect(titles(r.fit)).toEqual(
      titles([g.ticket, g.catan, g.brass, g.duel, g.blank, g.libib, g.twoCopies]),
    );
    expect(r.fitTotal).toBe(7);
    expect(r.unknown).toEqual([]);
  });

  it('players: a game fits when the count is inside its range, and a single count reads as exactly that', async () => {
    const { g } = await household();
    const four = await gamesForTonight(env.DB, f({ players: 4 }), 60);
    expect(titles(four.fit)).toEqual(titles([g.ticket, g.catan, g.brass, g.libib, g.twoCopies]));
    expect(titles(four.unknown)).toEqual([g.blank.title]); // Duel's "2" rules it out; the blank one can't be judged

    const two = await gamesForTonight(env.DB, f({ players: 2 }), 60);
    expect(titles(two.fit)).toEqual(titles([g.ticket, g.brass, g.duel, g.libib, g.twoCopies]));

    const six = await gamesForTonight(env.DB, f({ players: 6 }), 60);
    expect(titles(six.fit)).toEqual(titles([g.libib, g.twoCopies]));
  });

  it('time, conservatively: the longer end of its playing time must fit, an exact fit included', async () => {
    const { g } = await household();
    const hour = await gamesForTonight(env.DB, f({ minutes: 60 }), 60);
    // Ticket to Ride's 30–60 fits an hour; CATAN's 60–120 and Brass's don't, whatever their shortest game
    expect(titles(hour.fit)).toEqual(titles([g.ticket, g.duel, g.libib, g.twoCopies]));
    expect(titles(hour.unknown)).toEqual([g.blank.title]);

    const twenty = await gamesForTonight(env.DB, f({ minutes: 20 }), 60);
    expect(titles(twenty.fit)).toEqual(titles([g.duel, g.twoCopies]));
  });

  it('time: only a minimum known counts as the whole game, and Length stands in when details have neither', async () => {
    const { asha } = await household();
    const minOnly = await game(asha, 'Only a minimum', { players_min: 2, players_max: 4, playtime_min: 45 });
    const lengthOnly = await game(asha, 'Only a length', { players_min: 2, players_max: 4 }, { length: 50 });
    const wrongWay = await game(asha, 'Min above max', { playtime_min: 90, playtime_max: 30 });
    const fits = async (m: number) => titles((await gamesForTonight(env.DB, f({ minutes: m }), 60)).fit);
    expect(await fits(45)).toContain(minOnly.title);
    expect(await fits(45)).not.toContain(lengthOnly.title);
    expect(await fits(50)).toContain(lengthOnly.title);
    // a range entered backwards counts its larger end
    expect(await fits(60)).not.toContain(wrongWay.title);
    expect(await fits(90)).toContain(wrongWay.title);
  });

  it('weight: light below 2, medium from 2 to below 3, heavy from 3', async () => {
    const { g } = await household();
    const band = async (weight: GameFilters['weight']) => gamesForTonight(env.DB, f({ weight }), 60);
    expect(titles((await band('light')).fit)).toEqual(titles([g.ticket, g.libib, g.twoCopies]));
    expect(titles((await band('medium')).fit)).toEqual([g.catan.title]);
    expect(titles((await band('heavy')).fit)).toEqual([g.brass.title]);
    // Duel has no weight and the blank game nothing: both might be anything
    expect(titles((await band('heavy')).unknown)).toEqual(titles([g.duel, g.blank]));
  });

  it('weight: the band edges are exact', async () => {
    const { asha } = await household();
    const two = await game(asha, 'Exactly two', { weight: 2 });
    const three = await game(asha, 'Exactly three', { weight: 3 });
    const five = await game(asha, 'Exactly five', { weight: 5 });
    const band = async (weight: GameFilters['weight']) => titles((await gamesForTonight(env.DB, f({ weight }), 60)).fit);
    expect(await band('light')).not.toContain(two.title);
    expect(await band('medium')).toContain(two.title);
    expect(await band('medium')).not.toContain(three.title);
    expect(await band('heavy')).toEqual(expect.arrayContaining([three.title, five.title]));
  });

  it('combined: every filter must fit, and a game ruled out by one is never in the missing group', async () => {
    const { g } = await household();
    const r = await gamesForTonight(env.DB, f({ players: 4, minutes: 60, weight: 'light' }), 60);
    expect(titles(r.fit)).toEqual(titles([g.ticket, g.libib, g.twoCopies]));
    expect(titles(r.unknown)).toEqual([g.blank.title]);

    // Duel fits 2 players and 20 minutes but has no weight: missing, not fitting and not ruled out
    const duel = await gamesForTonight(env.DB, f({ players: 2, minutes: 30, weight: 'medium' }), 60);
    expect(titles(duel.fit)).toEqual([]);
    expect(titles(duel.unknown)).toEqual(titles([g.duel, g.blank]));
  });

  it('reads nothing it can’t: numbers, or text that is only a number; zero and junk are no value', async () => {
    const { asha } = await household();
    const junk = await game(asha, 'Junk details', { players_min: 'two', players_max: '4 players', playtime_max: 0, weight: '2.5.1' });
    const broken = await game(asha, 'Broken JSON', '{"players_min": 2,');
    const r = await gamesForTonight(env.DB, f({ players: 3, minutes: 60, weight: 'medium' }), 60);
    expect(titles(r.unknown)).toEqual(expect.arrayContaining([junk.title, broken.title]));
    expect(titles(r.fit)).not.toContain(junk.title);
  });

  it('reads filters from the URL strictly: anything else is "any"', () => {
    expect(parseGameFilters({ players: '4', time: '90', weight: 'heavy' })).toEqual({ players: 4, minutes: 90, weight: 'heavy' });
    expect(parseGameFilters({ players: '0', time: '-5', weight: 'HEAVY' })).toEqual(ANY);
    expect(parseGameFilters({ players: '2.5', time: '1e3', weight: 'constructor' })).toEqual(ANY);
    expect(parseGameFilters({ players: '100', time: '1441' })).toEqual(ANY);
    expect(parseGameFilters({ players: ' 3 ', time: '1440' })).toEqual({ players: 3, minutes: 1440, weight: null });
  });
});

// ---------- order, and the last play ----------

describe('the order', () => {
  it('is random, and the last play is shown but doesn’t steer it', async () => {
    const { asha, g } = await household();
    await logPlay(env.DB, g.catan.id, '2026-09-14', asha.id);
    await logPlay(env.DB, g.catan.id, '2025-06-01', asha.id);
    const orders = new Set<string>();
    for (let i = 0; i < 25; i++) orders.add((await gamesForTonight(env.DB, ANY, 60)).fit.map((x) => x.id).join(','));
    expect(orders.size).toBeGreaterThan(1); // 7 games: 5,040 orders — 25 draws all alike would be a fixed order

    const catan = (await gamesForTonight(env.DB, ANY, 60)).fit.find((x) => x.id === g.catan.id)!;
    expect(catan.lastPlayed).toBe('2026-09-14');
    const page = await html(asha, '/play');
    expect(page).toContain('last played 14 Sep');
    expect(page).toContain('not played yet');
  });

  it('shows at most the limit of each group, and says how many there are', async () => {
    const { asha } = await household();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
       INSERT INTO items (library_id, media_type, title, details) SELECT ?1, 'boardgame', 'Game ' || i,
         CASE WHEN i % 5 = 0 THEN '{}' ELSE json_object('players_min', 1 + i % 3, 'players_max', 4 + i % 3, 'playtime_max', 15 * (1 + i % 8), 'weight', 1 + (i % 40) / 10.0) END FROM n`,
    )
      .bind(shelf)
      .run();
    const r = await gamesForTonight(env.DB, f({ players: 4 }), 60);
    expect(r.fit).toHaveLength(60);
    expect(r.fitTotal).toBe(200 + 5); // 200 described, plus five of the household's
    expect(r.unknown).toHaveLength(51); // 50 blank, and the household's own
    expect(r.unknownTotal).toBe(51);
    const page = await html(asha, '/play?players=4');
    expect(page).toContain('Showing 60 of 205, in random order');
  });
});

// ---------- Pick one for us ----------

describe('Pick one for us', () => {
  it('picks only from the games that fit, never one missing a detail', async () => {
    const { g } = await household();
    const fitting = new Set([g.ticket.id, g.libib.id, g.twoCopies.id]);
    for (let i = 0; i < 20; i++) {
      const { pick, fitTotal, unknownTotal } = await pickGameForTonight(env.DB, f({ players: 4, minutes: 60, weight: 'light' }));
      expect(fitting.has(pick!.id)).toBe(true);
      expect([fitTotal, unknownTotal]).toEqual([3, 1]);
    }
  });

  it('"Pick another" never repeats the pick just shown while another fits — and does when it’s the only one', async () => {
    const { g } = await household();
    for (let i = 0; i < 15; i++) {
      const { pick } = await pickGameForTonight(env.DB, f({ weight: 'light' }), g.ticket.id);
      expect(pick!.id).not.toBe(g.ticket.id);
    }
    expect((await pickGameForTonight(env.DB, f({ weight: 'heavy' }), g.brass.id)).pick!.id).toBe(g.brass.id);
  });

  it('comes back empty when nothing fits, saying what might', async () => {
    const { asha } = await household();
    const none = await pickGameForTonight(env.DB, f({ players: 12 }));
    expect(none).toEqual({ pick: null, fitTotal: 0, unknownTotal: 1 });
    const card = await (await as(asha, '/play?players=12&pick=1', { htmx: true })).text();
    expect(card).toContain('Nothing to pick from');
    expect(card).toContain('See the 1 game missing details');
    expect(card).toContain('No game fits for 12 players, so there is nothing to pick. 1 game more might, but is missing details.');
  });

  it('shows the pick with its facts, and a "Pick another" that keeps the filters and its id', async () => {
    const { asha, g } = await household();
    const res = await as(asha, '/play?players=3&time=120&weight=medium&pick=1', { htmx: true });
    const card = await res.text();
    expect(card).toContain('Tonight’s pick');
    expect(card).toContain(`href="/items/${g.catan.id}"`);
    expect(card).not.toContain('<html');
    // CATAN is the only medium game: it is picked, and "Pick another" would show it again
    expect(card).toContain('Picked CATAN, from 1 game that fit.');
    expect(card).toContain('3–4 players');
    expect(card).toContain('Medium · 2.29');
    expect(card).toContain('id="play-again"');
    for (const hidden of ['name="players" value="3"', 'name="time" value="120"', 'name="weight" value="medium"', 'name="pick" value="1"', `name="not" value="${g.catan.id}"`]) {
      expect(card).toContain(hidden);
    }
    expect(card).toContain('hx-get="/play"');
    expect(card).toContain('hx-target="#play-results"');
  });
});

// ---------- the page ----------

describe('the page', () => {
  it('labels every control, and announces results in a live region the htmx answer fills out of band', async () => {
    const { asha } = await household();
    const page = await html(asha, '/play?players=4');
    expect(page).toMatch(/<label>Players<input type="number" name="players"[^>]*value="4"/);
    expect(page).toMatch(/<label>Time we have<select name="time">/);
    expect(page).toMatch(/<label>Weight<select name="weight">/);
    expect(page).toContain('<p id="play-status" class="play-status" role="status" aria-live="polite">');
    expect(page).toContain('5 games fit for 4 players. 1 game more might, but is missing details.');
    expect(page).toContain('Pick one for us');
    expect(page).toContain('<div id="play-results">');

    const res = await as(asha, '/play?players=4', { htmx: true });
    expect(res.headers.get('vary')).toContain('HX-Request');
    const partial = await res.text();
    expect(partial).not.toContain('<html');
    expect(partial).toContain('<p id="play-status" hx-swap-oob="innerHTML">5 games fit for 4 players.');
  });

  it('lists the games missing a detail in their own group, saying which detail', async () => {
    const { asha, g } = await household();
    const page = await html(asha, '/play?weight=heavy');
    const [fits, missing] = page.split('Not enough details');
    expect(fits).toContain(g.brass.title);
    expect(missing).toContain(g.duel.title);
    expect(missing).toContain(g.blank.title);
    expect(missing).toContain('weight not known');
    expect(missing).toContain('Refresh from BGG');
    expect(missing).not.toContain(g.brass.title);
  });

  it('says so when nothing fits, and when there are no games at all', async () => {
    const { asha } = await household();
    const none = await html(asha, '/play?players=12&weight=light');
    expect(none).toContain('No game fits — try more time, more players or another weight.');

    const lone = await member('lone');
    await env.DB.prepare('DELETE FROM items').run();
    const empty = await html(lone, '/play');
    expect(empty).toContain('No board games to play: none in the collection, or every copy is out on loan.');
  });

  it('keeps a time from the URL that isn’t one of the choices selected', async () => {
    const { asha } = await household();
    const page = await html(asha, '/play?time=75');
    expect(page).toContain('<option value="75" selected="">Up to 75 min</option>');
  });

  it('credits BGG under its data', async () => {
    const { asha } = await household();
    expect(await html(asha, '/play')).toContain('alt="Powered by BGG"');
  });

  it('is linked from the Overview and from a shelf showing board games — and not from a shelf without any', async () => {
    const { asha } = await household();
    const overview = await html(asha, '/');
    expect(overview).toContain('<a href="/play">What should we play tonight?</a>');
    expect(overview).toContain('Pick from 8 board games');
    expect(await html(asha, `/libraries/${shelf}`)).toContain('href="/play"');

    const books = await createLibrary(env.DB, 'Books');
    await createItem(env.DB, { libraryId: books.id, mediaType: 'book', title: 'Just a book', details: '{}' });
    expect(await html(asha, `/libraries/${books.id}`)).not.toContain('href="/play"');
    // filtered to board games, a shelf offers it even with none on it
    expect(await html(asha, `/libraries/${books.id}?type=boardgame`)).toContain('href="/play"');
  });

  it('leaves the Overview without the link when no game is in the collection', async () => {
    const asha = await member('asha', 'admin');
    const lib = await createLibrary(env.DB, 'Shelf');
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'boardgame', title: 'Wishlist game', copies: 0, details: '{}' });
    expect(await html(asha, '/')).not.toContain('href="/play"');
  });
});

// ---------- in the app only ----------

describe('in the app only', () => {
  it('sends a signed-out visitor to log in', async () => {
    await household();
    const res = await as(null, '/play');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    expect((await as(null, '/play?pick=1', { htmx: true })).headers.get('location')).toBe('/login');
  });

  it('is not on share pages, which show a game’s BGG details — its weight among them — as they always have', async () => {
    const { asha, g } = await household();
    const token = newShareToken();
    await createShare(env.DB, { token, libraryId: shelf!, name: 'Our games' });
    const list = await (await as(null, `/share/${token}`)).text();
    expect(list).not.toContain('/play');
    const item = await (await as(null, `/share/${token}/items/${g.catan.id}`)).text();
    expect(item).toContain('Weight (1–5)');
    expect(item).toContain('2.29');
    expect(item).not.toContain('/play');
    expect(item).not.toContain('Refresh from BGG');
    expect(item).not.toContain(`/items/${g.catan.id}/bgg`);
    void asha;
  });
});

// ---------- D1 calls ----------

describe('D1 calls', () => {
  const calls = async (who: Member, path: string, htmx = false) => {
    const budget = { left: 1000 };
    const headers: Record<string, string> = { cookie: who.cookie };
    if (htmx) headers['HX-Request'] = 'true';
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers }), { ...env, DB: budgeted(env.DB, budget) } as Bindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    await res.text();
    return 1000 - budget.left;
  };

  it('is one call for the results, whatever the filters or the catalog’s size', async () => {
    const { asha, g } = await household();
    const paths = ['/play', '/play?players=4&time=60&weight=light', '/play?pick=1', `/play?players=2&pick=1&not=${g.ticket.id}`];
    const small = await Promise.all(paths.map(async (p) => [await calls(asha, p), await calls(asha, p, true)]));
    // the whole page: the session, the sidebar's shelves and their counts (two), the results; for htmx, the session and
    // the results
    for (const [full, partial] of small) expect([full, partial]).toEqual([4, 2]);

    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
       INSERT INTO items (library_id, media_type, title, details) SELECT ?1, 'boardgame', 'Game ' || i,
         json_object('players_min', 1 + i % 3, 'players_max', 4 + i % 3, 'playtime_max', 15 * (1 + i % 8), 'weight', 1 + (i % 40) / 10.0) FROM n`,
    )
      .bind(shelf)
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
       INSERT INTO plays (item_id, played_on, logged_by) SELECT (SELECT min(id) FROM items WHERE media_type = 'boardgame') + i % 300, date('2026-01-01', '+' || (i % 250) || ' days'), ?1 FROM n`,
    )
      .bind(asha.id)
      .run();
    for (const p of paths) expect([await calls(asha, p), await calls(asha, p, true)]).toEqual([4, 2]);
  });

  it('reads the last play from the plays index', async () => {
    const plan = await rows<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT (SELECT max(p.played_on) FROM plays p WHERE p.item_id = i.id) FROM items i WHERE i.media_type = 'boardgame'",
    );
    expect(plan.map((r) => r.detail).join('\n')).toContain('idx_plays_item_played');
  });
});
