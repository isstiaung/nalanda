// The household's play log for board games and records (ARCH.md §16 #54): "Played" today or on a picked date, the
// count and the last play, who may remove one, books left out, the CSV round trip, share pages (a count, never a date),
// connections (nothing at all), and what it costs a page in D1 calls.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView } from '../src/db/federation';
import {
  createItem,
  createLibrary,
  createShare,
  deleteItem,
  deleteLibrary,
  deletePlay,
  deleteUser,
  logPlay,
  playLog,
  updateItemWithTags,
} from '../src/db/queries';
import type { Item, MediaType } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { clearSharedViewsCache } from '../src/federation/routes';
import { toConnectionItem } from '../src/federation/items';
import { formatPlaysCell, MAX_PLAYS_PER_ITEM, parsePlaysCell, playDate } from '../src/lib/plays';
import { latestReadDate, todayUtc } from '../src/lib/reads';
import { mapLibibRow } from '../src/lib/csv';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import { connectPeer, instanceA, makeKeys, makePeer, setUpA, type Peer } from './federation-helpers';
import { actor, as, html, member, rows, type Member } from './member-helpers';

async function thing(by: Member | null, mediaType: MediaType, values: Partial<Item> = {}): Promise<Item> {
  return createItem(env.DB, {
    libraryId: values.libraryId ?? (await createLibrary(env.DB, 'Games and records')).id,
    mediaType,
    title: mediaType === 'vinyl' ? 'Kind of Blue' : mediaType === 'book' ? 'The Dispossessed' : 'Azul',
    details: '{}',
    addedBy: by?.id ?? null,
    ...values,
  });
}

const playsOf = (itemId: number) =>
  rows<{ id: number; playedOn: string; loggedBy: number | null }>(
    'SELECT id, played_on AS playedOn, logged_by AS loggedBy FROM plays WHERE item_id = ?1 ORDER BY id',
    itemId,
  );

const itemRow = async (itemId: number) => (await rows('SELECT * FROM items WHERE id = ?1', itemId))[0]!;

const played = (who: Member, item: Item, date?: string, htmx = true) =>
  as(who, `/items/${item.id}/plays`, { body: date === undefined ? {} : { date }, htmx });

const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// ---------- logging a play ----------

describe('Played', () => {
  it('logs a play dated today, by whoever pressed it — with the date the form holds, or none sent', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    // the button's form carries today's date already: pressing it sends that
    const page = await html(asha, `/items/${game.id}`);
    expect(page).toContain(`name="date" value="${todayUtc()}"`);
    expect(page).toContain('>Played</button>');

    const res = await played(asha, game, todayUtc());
    expect(res.status).toBe(200);
    const section = await res.text();
    expect(section).toContain('id="plays"');
    expect(section).toContain('Played <span class="mono">once</span>');
    // a hand-made request with no date is today too
    await played(asha, game);
    expect(await playsOf(game.id)).toEqual([
      { id: expect.any(Number), playedOn: todayUtc(), loggedBy: asha.id },
      { id: expect.any(Number), playedOn: todayUtc(), loggedBy: asha.id },
    ]);
  });

  it('logs a play on another day picked beside the button — a record’s as a game’s', async () => {
    const ravi = await member('ravi');
    const record = await thing(ravi, 'vinyl');
    await played(ravi, record, '2025-09-14');
    expect(await playsOf(record.id)).toEqual([{ id: expect.any(Number), playedOn: '2025-09-14', loggedBy: ravi.id }]);
    const page = await html(ravi, `/items/${record.id}`);
    expect(page).toContain('Listening log');
    expect(page).toContain('last on <time class="mono" datetime="2025-09-14">14 Sep 2025</time>');
  });

  it('refuses a date that isn’t one, or is in the future, and says why — logging nothing', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    // negative control: tomorrow is allowed (a household east of UTC reaches it first), so the refusals below are the date's
    expect(await (await played(asha, game, latestReadDate())).text()).not.toContain('class="error"');
    expect(await playsOf(game.id)).toHaveLength(1);
    for (const [date, why] of [
      [daysFromNow(3), 'can’t be dated in the future'],
      ['2025-02-30', 'as a calendar date'],
      ['yesterday', 'as a calendar date'],
    ] as const) {
      const text = await (await played(asha, game, date)).text();
      expect(text).toContain(why);
    }
    expect(await playsOf(game.id)).toHaveLength(1);
  });

  it('without htmx, posts and comes back to the item page', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    const res = await played(asha, game, '2025-01-02', false);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/items/${game.id}`);
    expect(await playsOf(game.id)).toHaveLength(1);
  });

  it('changes nothing about the item: not its status, its reads, its dates or when it was last updated', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame', { status: 'completed', completedOn: '2024-05-01' });
    await env.DB.prepare("UPDATE items SET updated_at = '2020-01-01 00:00:00' WHERE id = ?1").bind(game.id).run();
    const before = await itemRow(game.id);
    const reads = await rows('SELECT * FROM reads WHERE item_id = ?1', game.id);
    await played(asha, game, '2025-03-03');
    await played(asha, game, todayUtc());
    expect(await itemRow(game.id)).toEqual(before);
    expect(await rows('SELECT * FROM reads WHERE item_id = ?1', game.id)).toEqual(reads);
    // negative control: the plays did land
    expect(await playsOf(game.id)).toHaveLength(2);
  });

  it('stops at the cap an item can hold', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    await env.DB.prepare(
      `INSERT INTO plays (item_id, played_on, logged_by) SELECT ?1, '2020-01-01', ?2 FROM json_each(?3)`,
    )
      .bind(game.id, asha.id, JSON.stringify(Array.from({ length: MAX_PLAYS_PER_ITEM - 1 }, () => 0)))
      .run();
    expect(await logPlay(env.DB, game.id, '2025-01-01', asha.id)).toBe(true); // the last one it takes
    expect(await logPlay(env.DB, game.id, '2025-01-01', asha.id)).toBe(false);
    expect(await (await played(asha, game, '2025-01-02')).text()).toContain('as many plays as it can hold');
    expect((await rows<{ n: number }>('SELECT count(*) AS n FROM plays WHERE item_id = ?1', game.id))[0]!.n).toBe(MAX_PLAYS_PER_ITEM);
  });
});

// ---------- the count, the last play, the recent list ----------

describe('the play log on the item page', () => {
  it('says how many times and when last, lists the five most recent, and links to the rest', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    const other = await thing(asha, 'boardgame', { title: 'Carcassonne' });
    const dates = ['2025-01-05', '2025-03-01', '2025-09-14', '2024-12-31', '2025-06-20', '2025-02-11', '2025-09-14'];
    for (const d of dates) await logPlay(env.DB, game.id, d, asha.id);
    await logPlay(env.DB, other.id, '2026-01-01', asha.id); // someone else's plays don't count here

    const page = await html(asha, `/items/${game.id}`);
    expect(page).toContain('Played <span class="mono">7 times</span> · last on <time class="mono" datetime="2025-09-14">14 Sep 2025</time>');
    const listed = [...page.matchAll(/<li><time class="mono" datetime="([\d-]+)">/g)].map((m) => m[1]);
    // newest first, the same day twice where it was played twice
    expect(listed).toEqual(['2025-09-14', '2025-09-14', '2025-06-20', '2025-03-01', '2025-02-11']);
    expect(page).toContain(`<a href="/items/${game.id}/plays">All 7 plays</a>`);

    const all = await html(asha, `/items/${game.id}/plays`);
    expect([...all.matchAll(/datetime="([\d-]+)"/g)].map((m) => m[1])).toEqual([
      '2025-09-14', '2025-09-14', '2025-06-20', '2025-03-01', '2025-02-11', '2025-01-05', '2024-12-31',
    ]);
    // under a heading per year, each date without its year
    expect(all).toContain('<p class="eyebrow mono">2025</p>');
    expect(all).toContain('<p class="eyebrow mono">2024</p>');
    expect(all).toContain('>31 Dec</time>');
  });

  it('says a game never played is not played yet, with no list and no link', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    const page = await html(asha, `/items/${game.id}`);
    expect(page).toContain('<p class="eyebrow">Play log</p>');
    expect(page).toContain('Not played yet.');
    expect(page).not.toContain('class="play-log"');
    expect(page).not.toContain('/plays">All');
  });

  it('shows the plays page a page at a time', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    await env.DB.prepare(`INSERT INTO plays (item_id, played_on, logged_by) SELECT ?1, date('2020-01-01', '+' || key || ' days'), ?2 FROM json_each(?3)`)
      .bind(game.id, asha.id, JSON.stringify(Array.from({ length: 150 }, () => 0)))
      .run();
    const first = await html(asha, `/items/${game.id}/plays`);
    const second = await html(asha, `/items/${game.id}/plays?page=2`);
    expect([...first.matchAll(/datetime=/g)]).toHaveLength(100);
    expect([...second.matchAll(/datetime=/g)]).toHaveLength(50);
    expect(first).toContain('1 / 2');
    expect(await html(asha, `/items/${game.id}/plays?page=9`)).toContain('No plays on this page.');
  });

  it('formats a play by the day: the year only when it isn’t this one', () => {
    expect(playDate('2026-09-14', '2026-09-30')).toBe('14 Sep');
    expect(playDate('2025-09-14', '2026-09-30')).toBe('14 Sep 2025');
    expect(playDate('2026-01-01', '2026-12-31')).toBe('1 Jan');
  });
});

// ---------- removing a play ----------

describe('removing a play', () => {
  async function household() {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const mira = await member('mira');
    const game = await thing(asha, 'boardgame');
    await logPlay(env.DB, game.id, '2025-05-01', ravi.id);
    await logPlay(env.DB, game.id, '2025-05-02', mira.id);
    const [his, hers] = await playsOf(game.id);
    return { asha, ravi, mira, game, his: his!, hers: hers! };
  }
  const remove = (who: Member, game: Item, playId: number) => as(who, `/items/${game.id}/plays/${playId}/delete`, { body: {}, htmx: true });

  it('lets whoever logged it remove it', async () => {
    const h = await household();
    expect((await remove(h.ravi, h.game, h.his.id)).status).toBe(200);
    expect((await playsOf(h.game.id)).map((p) => p.id)).toEqual([h.hers.id]);
  });

  it('refuses anyone else who isn’t an admin, with a reason — in the route and in the statement', async () => {
    const h = await household();
    const res = await remove(h.ravi, h.game, h.hers.id);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('logged by someone else');
    // the statement checks again, so a caller that skipped the route's check still removes nothing
    expect(await deletePlay(env.DB, h.game.id, h.hers.id, actor(h.ravi))).toBe(false);
    expect(await playsOf(h.game.id)).toHaveLength(2);
    // negative control: the same statement removes it for its logger
    expect(await deletePlay(env.DB, h.game.id, h.hers.id, actor(h.mira))).toBe(true);
    expect(await playsOf(h.game.id)).toHaveLength(1);
  });

  it('lets an admin remove anyone’s — a removed member’s too', async () => {
    const h = await household();
    await deleteUser(env.DB, h.mira.id);
    expect((await playsOf(h.game.id)).find((p) => p.id === h.hers.id)?.loggedBy).toBeNull();
    // nobody but an admin can remove a play whose logger is gone
    expect(await deletePlay(env.DB, h.game.id, h.hers.id, actor(h.ravi))).toBe(false);
    expect((await remove(h.asha, h.game, h.hers.id)).status).toBe(200);
    expect((await remove(h.asha, h.game, h.his.id)).status).toBe(200);
    expect(await playsOf(h.game.id)).toEqual([]);
  });

  it('offers Remove only where it is allowed, and names who logged each only to an admin', async () => {
    const h = await household();
    const removeButtons = (page: string) => [...page.matchAll(/\/plays\/(\d+)\/delete/g)].map((m) => Number(m[1]));
    const his = await html(h.ravi, `/items/${h.game.id}`);
    expect([...new Set(removeButtons(his))]).toEqual([h.his.id]);
    expect(his).not.toContain('class="muted play-by"');
    const admin = await html(h.asha, `/items/${h.game.id}`);
    expect([...new Set(removeButtons(admin))].sort()).toEqual([h.his.id, h.hers.id].sort());
    expect(admin).toContain('<span class="muted play-by">ravi</span>');
    expect(admin).toContain('<span class="muted play-by">mira</span>');
  });

  it('can’t remove a play through another item’s address', async () => {
    const h = await household();
    const elsewhere = await thing(h.asha, 'boardgame', { title: 'Elsewhere' });
    await remove(h.asha, elsewhere, h.his.id);
    expect(await playsOf(h.game.id)).toHaveLength(2);
  });

  it('comes back to the plays page when removed from there', async () => {
    const h = await household();
    const res = await as(h.asha, `/items/${h.game.id}/plays/${h.his.id}/delete?back=${encodeURIComponent('plays?page=1')}`, { body: {} });
    expect(res.headers.get('location')).toBe(`/items/${h.game.id}/plays?page=1`);
    // anything else it is handed goes back to the item page, never elsewhere
    const odd = await as(h.asha, `/items/${h.game.id}/plays/${h.hers.id}/delete?back=${encodeURIComponent('//evil.example')}`, { body: {} });
    expect(odd.headers.get('location')).toBe(`/items/${h.game.id}`);
  });
});

// ---------- whose plays, when things go ----------

describe('plays belong to the household', () => {
  it('stay when the member who logged them is removed, unattributed', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const game = await thing(asha, 'boardgame');
    await played(ravi, game, '2025-04-04');
    await deleteUser(env.DB, ravi.id);
    expect(await playsOf(game.id)).toEqual([{ id: expect.any(Number), playedOn: '2025-04-04', loggedBy: null }]);
    expect(await html(asha, `/items/${game.id}`)).toContain('Played <span class="mono">once</span>');
  });

  it('go with their item, and with its shelf', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    const record = await thing(asha, 'vinyl');
    await logPlay(env.DB, game.id, '2025-01-01', asha.id);
    await logPlay(env.DB, record.id, '2025-01-01', asha.id);
    await deleteItem(env.DB, game.id);
    expect(await playsOf(game.id)).toEqual([]);
    expect(await playsOf(record.id)).toHaveLength(1); // negative control: only that item's
    await deleteLibrary(env.DB, record.libraryId);
    expect(await rows('SELECT * FROM plays')).toEqual([]);
  });
});

// ---------- not for books ----------

describe('books have reads, not plays', () => {
  it('shows no play log and no Played button on a book — or on anything else that isn’t a game or a record', async () => {
    const asha = await member('asha', 'admin');
    for (const type of ['book', 'music', 'movie', 'videogame', 'other'] as const) {
      const page = await html(asha, `/items/${(await thing(asha, type)).id}`);
      expect(page).not.toContain('id="plays"');
      expect(page).not.toContain('>Played</button>');
    }
    // negative control: the same check finds them on a game
    const page = await html(asha, `/items/${(await thing(asha, 'boardgame')).id}`);
    expect(page).toContain('id="plays"');
    expect(page).toContain('>Played</button>');
  });

  it('refuses a play of a book, in the route and in the statement', async () => {
    const asha = await member('asha', 'admin');
    const book = await thing(asha, 'book');
    const res = await played(asha, book, '2025-01-01');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('A book has reads');
    expect(await logPlay(env.DB, book.id, '2025-01-01', asha.id)).toBe(false);
    expect(await playsOf(book.id)).toEqual([]);
  });

  it('keeps the plays of a record whose type became a book on its page, to see and remove, with no button', async () => {
    const asha = await member('asha', 'admin');
    const record = await thing(asha, 'vinyl');
    await logPlay(env.DB, record.id, '2025-01-01', asha.id);
    await updateItemWithTags(env.DB, record.id, { mediaType: 'book' }, [], undefined, asha.id);
    const page = await html(asha, `/items/${record.id}`);
    expect(page).toContain('id="plays"');
    expect(page).toContain('Played <span class="mono">once</span>');
    expect(page).not.toContain('>Played</button>');
    expect(page).toContain('/delete"');
  });
});

// ---------- export and import ----------

function parseCsv(text: string): Record<string, string>[] {
  const out: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) out.push([...row, field]);
  const [header, ...body] = out;
  return body.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ''])));
}

describe('plays in the export and import', () => {
  async function exported(who: Member) {
    const res = await as(who, '/export.csv?after=0');
    return parseCsv(await res.text());
  }

  it('export each play, oldest first, with who logged it — a removed member’s as an empty name', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const gone = await member('gone');
    const game = await thing(asha, 'boardgame');
    await logPlay(env.DB, game.id, '2025-09-14', ravi.id);
    await logPlay(env.DB, game.id, '2024-01-02', asha.id);
    await logPlay(env.DB, game.id, '2025-01-01', gone.id);
    await deleteUser(env.DB, gone.id);
    await thing(asha, 'boardgame', { title: 'Never played' });
    const csv = await exported(asha);
    expect(Object.keys(csv[0]!)).toContain('plays');
    expect(csv.find((r) => r.title === 'Azul')!.plays).toBe('2024-01-02@asha;2025-01-01@;2025-09-14@ravi');
    expect(csv.find((r) => r.title === 'Never played')!.plays).toBe('');
  });

  it('come back through an admin’s import with their dates and loggers', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const game = await thing(asha, 'boardgame');
    const record = await thing(asha, 'vinyl');
    for (const d of ['2025-09-14', '2025-09-14', '2023-03-03']) await logPlay(env.DB, game.id, d, ravi.id);
    await logPlay(env.DB, record.id, '2025-02-02', asha.id);
    const csv = await exported(asha);
    const target = await createLibrary(env.DB, 'Restored');
    const res = await as(asha, '/api/import', { json: { libraryId: target.id, rows: csv } });
    expect(await res.json()).toMatchObject({ inserted: 2 });
    const restored = await rows<{ title: string; playedOn: string; loggedBy: number }>(
      `SELECT i.title, p.played_on AS playedOn, p.logged_by AS loggedBy FROM plays p JOIN items i ON i.id = p.item_id
       WHERE i.library_id = ?1 ORDER BY i.title, p.played_on`,
      target.id,
    );
    expect(restored).toEqual([
      { title: 'Azul', playedOn: '2023-03-03', loggedBy: ravi.id },
      { title: 'Azul', playedOn: '2025-09-14', loggedBy: ravi.id },
      { title: 'Azul', playedOn: '2025-09-14', loggedBy: ravi.id },
      { title: 'Kind of Blue', playedOn: '2025-02-02', loggedBy: asha.id },
    ]);
    // and the export of what came back says the same
    const again = (await exported(asha)).filter((r) => r.title === 'Azul').map((r) => r.plays);
    expect(again).toEqual(['2023-03-03@ravi;2025-09-14@ravi;2025-09-14@ravi', '2023-03-03@ravi;2025-09-14@ravi;2025-09-14@ravi']);
  });

  it('are all the importer’s in a member’s import, as reads are', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const game = await thing(asha, 'boardgame');
    await logPlay(env.DB, game.id, '2025-09-14', asha.id);
    const csv = await exported(asha);
    const target = await createLibrary(env.DB, 'Ravi’s copy');
    await as(ravi, '/api/import', { json: { libraryId: target.id, rows: csv } });
    expect(await rows('SELECT p.logged_by AS loggedBy FROM plays p JOIN items i ON i.id = p.item_id WHERE i.library_id = ?1', target.id)).toEqual([
      { loggedBy: ravi.id },
    ]);
  });

  it('are none from an export made before plays, whose games and records arrive unplayed', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    await logPlay(env.DB, game.id, '2025-09-14', asha.id);
    const csv = (await exported(asha)).map(({ plays: _plays, ...rest }) => rest); // a 1.3.0 export has no such column
    expect(Object.keys(csv[0]!)).not.toContain('plays');
    const target = await createLibrary(env.DB, 'From 1.3.0');
    expect(await (await as(asha, '/api/import', { json: { libraryId: target.id, rows: csv } })).json()).toMatchObject({ inserted: 1 });
    const [copy] = await rows<{ id: number; mediaType: string; details: string }>(
      'SELECT id, media_type AS mediaType, details FROM items WHERE library_id = ?1',
      target.id,
    );
    expect(copy!.mediaType).toBe('boardgame');
    expect(await playsOf(copy!.id)).toEqual([]);
    expect(copy!.details).toBe('{}');
  });

  it('parse a cell as leniently as reads: bad parts dropped, the rest kept, never a future date', () => {
    expect(parsePlaysCell('2025-01-01@asha; 2025-02-30@asha ;junk;2025-03-01;2025-04-01@;2025-05-01@r%C3%A9mi')).toEqual([
      { playedOn: '2025-01-01', by: 'asha' },
      { playedOn: '2025-03-01' },
      { playedOn: '2025-04-01', by: null },
      { playedOn: '2025-05-01', by: 'rémi' },
    ]);
    expect(parsePlaysCell(`${daysFromNow(5)}@asha`)).toEqual([]);
    expect(parsePlaysCell('')).toEqual([]);
    expect(parsePlaysCell(undefined)).toEqual([]);
    const odd = [{ playedOn: '2025-01-01', by: 'a;b@c,d' }];
    expect(parsePlaysCell(formatPlaysCell(odd))).toEqual(odd);
  });

  it('keep a plays column out of a libib file’s details, where share pages would show its dates', () => {
    const mapped = mapLibibRow({ title: 'Azul', item_type: 'board game', plays: '2025-01-01;2025-02-02' }, { defaultType: 'book', musicAsVinyl: true });
    expect(mapped!.item.details).toBe('{}');
    // negative control: any other column it doesn't know does land there
    const other = mapLibibRow({ title: 'Azul', item_type: 'board game', shelf_spot: 'B2' }, { defaultType: 'book', musicAsVinyl: true });
    expect(JSON.parse(other!.item.details ?? '{}')).toEqual({ shelf_spot: 'B2' });
  });
});

// ---------- share pages ----------

describe('share pages', () => {
  async function sharedShelf() {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Games');
    const game = await thing(asha, 'boardgame', { libraryId: shelf.id });
    const record = await thing(asha, 'vinyl', { libraryId: shelf.id });
    const book = await thing(asha, 'book', { libraryId: shelf.id });
    const unplayed = await thing(asha, 'boardgame', { libraryId: shelf.id, title: 'Unplayed' });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Our games', libraryId: shelf.id });
    clearSharePageCache();
    return { asha, shelf, game, record, book, unplayed, token: share.token };
  }
  const shared = async (token: string, itemId: number) => (await as(null, `/share/${token}/items/${itemId}`)).text();

  it('say how many times a game or record was played — never when, nor who logged it', async () => {
    const s = await sharedShelf();
    for (const d of ['2025-09-14', '2025-08-02', '2024-12-25']) await logPlay(env.DB, s.game.id, d, s.asha.id);
    await logPlay(env.DB, s.record.id, '2025-07-07', s.asha.id);
    const game = await shared(s.token, s.game.id);
    expect(game).toContain('<dt>Played</dt><dd class="mono">3 times</dd>');
    expect(await shared(s.token, s.record.id)).toContain('<dt>Played</dt><dd class="mono">once</dd>');
    for (const secret of ['2025-09-14', '2025-08-02', '2024-12-25', '14 Sep', '25 Dec', 'asha', 'last on', '/plays']) {
      expect(game).not.toContain(secret);
    }
    // negative control: the signed-in page does carry those dates, so the check above can see them
    const inside = await html(s.asha, `/items/${s.game.id}`);
    expect(inside).toContain('2025-09-14');
    expect(inside).toContain('14 Sep 2025');
  });

  it('say nothing of plays for a game never played, or a book', async () => {
    const s = await sharedShelf();
    await env.DB.prepare("INSERT INTO plays (item_id, played_on, logged_by) VALUES (?1, '2025-01-01', ?2)").bind(s.book.id, s.asha.id).run();
    expect(await shared(s.token, s.unplayed.id)).not.toContain('<dt>Played</dt>');
    expect(await shared(s.token, s.book.id)).not.toContain('<dt>Played</dt>');
  });

  it('carry the count only through the whitelist, only when given it', async () => {
    const s = await sharedShelf();
    const game = (await rows<Item>('SELECT * FROM items WHERE id = ?1', s.game.id))[0]!;
    const asItem = { ...game, mediaType: 'boardgame' as const, copies: 1, readCount: 0, rereading: false } as Item;
    expect(toPublicItem(asItem, { plays: 4 })).toMatchObject({ playCount: 4 });
    expect(toPublicItem(asItem)).not.toHaveProperty('playCount');
    expect(toPublicItem(asItem, { plays: 0 })).not.toHaveProperty('playCount');
    expect(toPublicItem({ ...asItem, mediaType: 'book' }, { plays: 4 })).not.toHaveProperty('playCount');
    for (const forbidden of ['plays', 'playedOn', 'lastPlayed', 'loggedBy']) expect(toPublicItem(asItem, { plays: 4 })).not.toHaveProperty(forbidden);
  });

  it('leave the listing cards as they were', async () => {
    const s = await sharedShelf();
    const before = await (await as(null, `/share/${s.token}`)).text();
    await logPlay(env.DB, s.game.id, '2025-01-01', s.asha.id);
    clearSharePageCache();
    expect(await (await as(null, `/share/${s.token}`)).text()).toBe(before);
  });
});

// ---------- connections ----------

describe('connections', () => {
  let a: ReturnType<typeof instanceA>;
  let peer: Peer;
  beforeEach(async () => {
    const keys = await makeKeys();
    a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
    clearSharedViewsCache();
    await setUpA();
    peer = await makePeer('Riverbank library');
    await connectPeer(peer);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('are sent no plays: no count, no dates, on the item page, the shelf or the feed', async () => {
    const view = await createConnectionView(env.DB, { name: 'Everything', libraryId: null, mediaType: null, status: null, owned: null });
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame', { rating: 8 });
    for (const d of ['2025-09-14', '2025-09-15']) await logPlay(env.DB, game.id, d, asha.id);
    const detail = await (await a.signedGet(`/federation/item?view=${view.id}&id=${game.id}`, peer)).text();
    const shelf = await (await a.signedGet(`/federation/shelf?view=${view.id}&page=1`, peer)).text();
    const feed = await (await a.signedGet(`/federation/feed?view=${view.id}&since=0`, peer)).text();
    // negative control: the item and its rating did reach them
    expect(JSON.parse(detail)).toMatchObject({ title: 'Azul', rating: 8 });
    expect(shelf).toContain('Azul');
    expect(feed).toContain('Azul');
    for (const text of [detail, shelf, feed]) {
      expect(text).not.toMatch(/play/i);
      expect(text).not.toContain('2025-09-14');
    }
    expect(toConnectionItem(game)).not.toHaveProperty('playCount');
  });

  it('hear nothing when a play is logged: no activity, per household or per person', async () => {
    await createConnectionView(env.DB, { name: 'Everything', libraryId: null, mediaType: null, status: null, owned: null });
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    const logs = async () => ({
      household: await rows('SELECT * FROM activity_log ORDER BY id'),
      person: await rows('SELECT * FROM member_activity ORDER BY id'),
    });
    const before = await logs();
    await played(asha, game, todayUtc());
    await played(asha, game, '2025-01-01');
    expect(await logs()).toEqual(before);
    // negative control: a rating on the same item is news, so the logs are live
    await updateItemWithTags(env.DB, game.id, {}, [], undefined, asha.id, { rating: 8, review: null });
    expect((await logs()).household.length).toBeGreaterThan(before.household.length);
  });
});

// ---------- the D1 budget ----------

describe('D1 calls', () => {
  async function calls(who: Member | null, path: string) {
    const budget = { left: 1000 };
    const headers: Record<string, string> = {};
    if (who) headers.cookie = who.cookie;
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers }), { ...env, DB: budgeted(env.DB, budget) } as Bindings, ctx);
    await res.text();
    await waitOnExecutionContext(ctx);
    return { status: res.status, calls: 1000 - budget.left };
  }
  const manyPlays = (itemId: number, by: number, n: number) =>
    env.DB.prepare(`INSERT INTO plays (item_id, played_on, logged_by) SELECT ?1, date('2020-01-01', '+' || key || ' days'), ?2 FROM json_each(?3)`)
      .bind(itemId, by, JSON.stringify(Array.from({ length: n }, () => 0)))
      .run();

  it('cost a game’s page one call, however many plays it has', async () => {
    const asha = await member('asha', 'admin');
    const quiet = await thing(asha, 'boardgame', { title: 'Quiet' });
    const busy = await thing(asha, 'boardgame', { title: 'Busy' });
    const book = await thing(asha, 'book');
    await manyPlays(busy.id, asha.id, 400);
    const none = await calls(asha, `/items/${quiet.id}`);
    const lots = await calls(asha, `/items/${busy.id}`);
    const aBook = await calls(asha, `/items/${book.id}`);
    expect([none.status, lots.status, aBook.status]).toEqual([200, 200, 200]);
    expect(lots.calls).toBe(none.calls);
    expect(aBook.calls).toBe(none.calls); // a book asks too — it may hold plays from before its type changed
    expect(lots.calls).toBeLessThanOrEqual(12);
    const all = await calls(asha, `/items/${busy.id}/plays?page=2`);
    expect(all.status).toBe(200);
    expect(all.calls).toBeLessThanOrEqual(6);
  });

  it('cost a share page the same for a hit and a miss, well inside the budget', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Shared');
    const other = await createLibrary(env.DB, 'Private');
    const game = await thing(asha, 'boardgame', { libraryId: shelf.id });
    const outside = await thing(asha, 'boardgame', { libraryId: other.id });
    await manyPlays(game.id, asha.id, 50);
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'View', libraryId: shelf.id });
    clearSharePageCache();
    const hit = await calls(null, `/share/${token}/items/${game.id}`);
    const miss = await calls(null, `/share/${token}/items/${outside.id}`);
    const missing = await calls(null, `/share/${token}/items/999999`);
    expect([hit.status, miss.status, missing.status]).toEqual([200, 404, 404]);
    expect(hit.calls).toBe(miss.calls);
    expect(missing.calls).toBe(miss.calls);
    expect(hit.calls).toBeLessThanOrEqual(6);
  });

  it('cost an export page the same however many plays, well inside the budget', async () => {
    const asha = await member('asha', 'admin');
    const games: Item[] = [];
    for (let i = 0; i < 5; i++) games.push(await thing(asha, 'boardgame', { title: `Game ${i}` }));
    const unplayed = await calls(asha, '/export.csv?after=0');
    for (const g of games) await manyPlays(g.id, asha.id, 100);
    const played = await calls(asha, '/export.csv?after=0');
    expect([unplayed.status, played.status]).toEqual([200, 200]);
    expect(played.calls).toBe(unplayed.calls);
    // the session's own, libraries, the page of items, then tags, progress, reads, reviews and plays at once
    expect(played.calls).toBeLessThanOrEqual(10);
  });
});

// ---------- what later work will ask of the table ----------

describe('the plays table answers what comes next from its indexes', () => {
  const plan = async (query: string) =>
    (await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`).all<{ detail: string }>()).results.map((r) => r.detail).join(' | ');

  it('plays per item in a year ("year in review") and last played per item ("what to play tonight")', async () => {
    const year = await plan(
      "SELECT item_id, count(*) FROM plays WHERE played_on BETWEEN '2025-01-01' AND '2025-12-31' GROUP BY item_id",
    );
    expect(year).toContain('idx_plays_played_item');
    expect(year).not.toMatch(/SCAN plays(?! USING)/);
    const last = await plan("SELECT item_id, max(played_on) FROM plays GROUP BY item_id");
    expect(last).toContain('idx_plays_item_played');
    const page = await plan('SELECT id, played_on FROM plays WHERE item_id = 1 ORDER BY played_on DESC, id DESC LIMIT 5');
    expect(page).toContain('idx_plays_item_played');
    // negative control: a query no index serves says so in the same words
    expect(await plan("SELECT * FROM plays WHERE created_at > '2025-01-01'")).toMatch(/SCAN plays(?! USING)/);
  });

  it('answers them correctly', async () => {
    const asha = await member('asha', 'admin');
    const game = await thing(asha, 'boardgame');
    const record = await thing(asha, 'vinyl');
    for (const d of ['2024-12-31', '2025-01-01', '2025-06-01']) await logPlay(env.DB, game.id, d, asha.id);
    await logPlay(env.DB, record.id, '2025-03-03', asha.id);
    expect(
      await rows("SELECT item_id AS itemId, count(*) AS n FROM plays WHERE played_on BETWEEN '2025-01-01' AND '2025-12-31' GROUP BY item_id ORDER BY item_id"),
    ).toEqual([
      { itemId: game.id, n: 2 },
      { itemId: record.id, n: 1 },
    ]);
    expect(await rows('SELECT item_id AS itemId, max(played_on) AS last FROM plays GROUP BY item_id ORDER BY item_id')).toEqual([
      { itemId: game.id, last: '2025-06-01' },
      { itemId: record.id, last: '2025-03-03' },
    ]);
    expect((await playLog(env.DB, game.id)).count).toBe(3);
  });
});
