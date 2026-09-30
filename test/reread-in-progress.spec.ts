// A book being read again counts as In progress (ARCH.md §16 #64): the shelf's Status filter, share links and
// connection views filtered to In progress list a re-read — which still stays under Completed — its status shows as
// "Re-reading", and a connection view's feed carries no news for a book that only entered or left it.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countItemsInView,
  createConnectionView,
  itemMatchesView,
  recommendableItem,
  sharedItem,
  sharedReviewedItem,
  shelfPage,
} from '../src/db/federation';
import { addProgress, closeRead, countMatchingItems, createLibrary, createShare, getItem, listItems, startRead } from '../src/db/queries';
import { ITEM_STATUSES, type Item, type ItemStatus } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { clearSharedViewsCache } from '../src/federation/routes';
import { matchesStatus } from '../src/lib/reads';
import { itemMatchesShare, newShareToken, shareFilters, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import { connectPeer, instanceA, makeKeys, makePeer, setUpA, type Keys, type Peer } from './federation-helpers';
import { actor, as, book, html, member, rows, upgradedSwitches, type Member } from './member-helpers';

const today = new Date().toISOString().slice(0, 10);
const openRead = async (itemId: number) =>
  (await rows<{ id: number }>("SELECT id FROM reads WHERE item_id = ?1 AND status = 'in_progress'", itemId))[0]!.id;

/**
 * Asha (an admin) and Ravi, and one of each: a first read in progress by each, a book Asha finished that Ravi is
 * reading now, one she finished and is reading again herself, one Ravi finished, one not started, one stopped.
 */
async function household() {
  const asha = await member('asha', 'admin');
  const ravi = await member('ravi');
  const shelf = await createLibrary(env.DB, 'Main');
  const on = (by: Member, title: string, values: Partial<Item> = {}) => book(by, { libraryId: shelf.id, title, ...values });
  const b = {
    hersNow: await on(asha, 'Hers now', { status: 'in_progress', beganOn: '2026-09-01' }),
    hisNow: await on(ravi, 'His now', { status: 'in_progress', beganOn: '2026-09-02' }),
    hisReread: await on(asha, 'His reread', { status: 'completed', beganOn: '2019-01-01', completedOn: '2019-02-01' }),
    herReread: await on(asha, 'Her reread', { status: 'completed', beganOn: '2018-01-01', completedOn: '2018-02-01', review: 'Better the second time.' }),
    finished: await on(ravi, 'Finished', { status: 'completed', beganOn: '2020-01-01', completedOn: '2020-02-01', review: 'Long.' }),
    unread: await on(asha, 'Not started'),
    stopped: await on(asha, 'Stopped', { status: 'abandoned', beganOn: '2021-01-01', completedOn: '2021-02-01' }),
  };
  await startRead(env.DB, b.hisReread.id, '2026-09-10', ravi.id);
  await startRead(env.DB, b.herReread.id, '2026-09-11', asha.id);
  const fresh = async () => Promise.all(Object.values(b).map(async (i) => (await getItem(env.DB, i.id))!));
  return { asha, ravi, shelf, b, fresh };
}

const titles = (items: Item[]) => items.map((i) => i.title).sort();
const READING_NOW = ['Her reread', 'Hers now', 'His now', 'His reread'];
const FINISHED = ['Finished', 'Her reread', 'His reread'];

describe('the household the tests share', () => {
  it('has two re-reads, still Completed, and two first reads in progress', async () => {
    const { fresh } = await household();
    const state = Object.fromEntries((await fresh()).map((i) => [i.title, [i.status, i.rereading]]));
    expect(state).toEqual({
      'Hers now': ['in_progress', false],
      'His now': ['in_progress', false],
      'His reread': ['completed', true],
      'Her reread': ['completed', true],
      Finished: ['completed', false],
      'Not started': ['not_started', false],
      Stopped: ['abandoned', false],
    });
  });
});

// ---------- the app's own shelf ----------

describe('the shelf’s Status filter', () => {
  it('lists every book being read now under In progress, re-reads included, whoever is reading', async () => {
    const { asha, ravi, shelf } = await household();
    for (const who of [asha, ravi]) {
      const page = await html(who, `/libraries/${shelf.id}?status=in_progress`);
      for (const t of READING_NOW) expect(page, `${t}, for ${who.name}`).toContain(`title="${t}"`);
      for (const t of ['Finished', 'Not started', 'Stopped']) expect(page, `${t}, for ${who.name}`).not.toContain(`title="${t}"`);
    }
    expect(titles((await listItems(env.DB, shelf.id, { statuses: ['in_progress'] })).items)).toEqual(READING_NOW);
    expect(await countMatchingItems(env.DB, shelf.id, { statuses: ['in_progress'] })).toBe(4);
  });

  it('still lists a re-read under Completed, and once when both are ticked', async () => {
    const { asha, shelf } = await household();
    const page = await html(asha, `/libraries/${shelf.id}?status=completed`);
    for (const t of FINISHED) expect(page).toContain(`title="${t}"`);
    for (const t of ['Hers now', 'His now']) expect(page).not.toContain(`title="${t}"`);
    expect(titles((await listItems(env.DB, shelf.id, { statuses: ['completed'] })).items)).toEqual(FINISHED);

    const both = await listItems(env.DB, shelf.id, { statuses: ['in_progress', 'completed'] });
    expect(titles(both.items)).toEqual(['Finished', ...READING_NOW].sort());
    expect(both.total).toBe(5);
    // the other statuses are the column, as before
    expect(titles((await listItems(env.DB, shelf.id, { statuses: ['not_started'] })).items)).toEqual(['Not started']);
    expect(titles((await listItems(env.DB, shelf.id, { statuses: ['abandoned'] })).items)).toEqual(['Stopped']);
  });

  it('agrees with matchesStatus() for every status', async () => {
    const { shelf, fresh } = await household();
    const items = await fresh();
    for (const status of ITEM_STATUSES) {
      const listed = titles((await listItems(env.DB, shelf.id, { statuses: [status] })).items);
      expect(listed, status).toEqual(titles(items.filter((i) => matchesStatus(i, status))));
    }
  });

  it('shows "Re-reading" in place of Completed on a re-read’s row, card and page, and In progress on a first read', async () => {
    const { ravi, shelf, b } = await household();
    const table = await html(ravi, `/libraries/${shelf.id}?status=in_progress`);
    const row = (title: string) => table.slice(table.indexOf(`title="${title}"`), table.indexOf('</tr>', table.indexOf(`title="${title}"`)));
    for (const t of ['His reread', 'Her reread']) {
      expect(row(t)).toContain('<td class="col-status"><span class="pill rereading">Re-reading</span>');
      expect(row(t)).not.toContain('Completed</span>');
    }
    for (const t of ['His now', 'Hers now']) expect(row(t)).toContain('<span class="pill progress">In progress</span>');
    expect(table).not.toContain('pill done">Completed'); // nothing in an In progress list looks finished

    // a finished book, not being read, is still Completed
    const done = await html(ravi, `/libraries/${shelf.id}?status=completed`);
    expect(table).not.toContain('title="Finished"');
    expect(done.slice(done.indexOf('title="Finished"'))).toMatch(/^[^]*?<span class="pill done">Completed<\/span>/);

    expect(await html(ravi, `/libraries/${shelf.id}?status=in_progress&view=grid`)).toContain('<span class="pill rereading">Re-reading</span>');
    const page = await html(ravi, `/items/${b.hisReread.id}`);
    expect(page).toContain('<span id="item-status" class="status-pills"><span class="pill rereading">Re-reading</span></span>');
    expect(await html(ravi, `/items/${b.finished.id}`)).toContain(
      '<span id="item-status" class="status-pills"><span class="pill done">Completed</span></span>',
    );
  });

  it('goes back to Completed only, once the re-read is finished or stopped', async () => {
    const { asha, ravi, shelf, b } = await household();
    await closeRead(env.DB, b.hisReread.id, await openRead(b.hisReread.id), 'completed', today, actor(ravi));
    await closeRead(env.DB, b.herReread.id, await openRead(b.herReread.id), 'abandoned', today, actor(asha));
    expect(titles((await listItems(env.DB, shelf.id, { statuses: ['in_progress'] })).items)).toEqual(['Hers now', 'His now']);
    expect(titles((await listItems(env.DB, shelf.id, { statuses: ['completed'] })).items)).toEqual(FINISHED);
  });
});

// ---------- share links ----------

describe('share links filtered by status', () => {
  it('agree with their item-side twin for a re-read, for every status', async () => {
    const { shelf, fresh } = await household();
    const items = await fresh();
    for (const status of [null, ...ITEM_STATUSES]) {
      const view = await createShare(env.DB, { token: newShareToken(), name: `By ${status}`, libraryId: shelf.id, status });
      const listed = (await listItems(env.DB, view.libraryId, shareFilters(view))).items.map((i) => i.id).sort();
      const admitted = items.filter((i) => itemMatchesShare(view, i, [], [])).map((i) => i.id).sort();
      expect(admitted, String(status)).toEqual(listed);
      expect(await countMatchingItems(env.DB, view.libraryId, shareFilters(view))).toBe(listed.length);
    }
  });

  it('publish a re-read in an In progress link, and open its page — with no status or re-read on it', async () => {
    const { shelf, b } = await household();
    clearSharePageCache();
    const link = await createShare(env.DB, { token: newShareToken(), name: 'Reading now', libraryId: shelf.id, status: 'in_progress' });
    const listing = await html(null, `/share/${link.token}`);
    for (const t of READING_NOW) expect(listing).toContain(t);
    expect(listing).not.toContain('>Finished<');

    const res = await as(null, `/share/${link.token}/items/${b.hisReread.id}`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).not.toMatch(/re-?reading/i);
    expect(page).not.toContain('Completed');
    expect((await as(null, `/share/${link.token}/items/${b.finished.id}`)).status).toBe(404); // negative control
    for (const key of ['status', 'rereading']) expect(toPublicItem((await getItem(env.DB, b.hisReread.id))!)).not.toHaveProperty(key);
  });
});

// ---------- connection views ----------

describe('connection views filtered by status', () => {
  let keysA: Keys;
  let a: ReturnType<typeof instanceA>;
  let peer: Peer;
  beforeEach(async () => {
    keysA = await makeKeys();
    a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
    clearSharedViewsCache();
    await setUpA();
    peer = await makePeer('Riverbank library');
    await connectPeer(peer);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('agree across the SQL and in-memory twins, for every status', async () => {
    const { fresh } = await household();
    const items = await fresh();
    for (const status of [null, ...ITEM_STATUSES]) {
      const view = await createConnectionView(env.DB, { name: `By ${status}`, libraryId: null, mediaType: null, status, owned: null });
      const listed = (await shelfPage(env.DB, view, 1)).items.map((i) => i.id).sort();
      expect(items.filter((i) => itemMatchesView(view, i)).map((i) => i.id).sort(), String(status)).toEqual(listed);
      expect(await countItemsInView(env.DB, view)).toBe(listed.length);
    }
  });

  it('hold a re-read in an In progress view: its shelf, its item page, and what a comment or a recommendation asks', async () => {
    const { b } = await household();
    const view = await createConnectionView(env.DB, { name: 'Reading now', libraryId: null, mediaType: 'book', status: 'in_progress', owned: null });

    const shelf = (await (await a.signedGet(`/federation/shelf?view=${view.id}`, peer)).json()) as { items: Array<{ title: string }> };
    expect(shelf.items.map((i) => i.title).sort()).toEqual(READING_NOW);
    expect((await a.signedGet(`/federation/item?view=${view.id}&id=${b.hisReread.id}`, peer)).status).toBe(200);
    expect((await a.signedGet(`/federation/item?view=${view.id}&id=${b.finished.id}`, peer)).status).toBe(404);

    // the raw-SQL twins of itemMatchesView()
    expect((await sharedItem(env.DB, b.hisReread.id))?.id).toBe(b.hisReread.id);
    expect(await sharedItem(env.DB, b.finished.id)).toBeNull();
    expect((await sharedReviewedItem(env.DB, b.herReread.id))?.id).toBe(b.herReread.id);
    expect(await sharedReviewedItem(env.DB, b.finished.id)).toBeNull();
    expect((await recommendableItem(env.DB, b.hisReread.id))?.viewId).toBe(view.id);
    expect(await recommendableItem(env.DB, b.finished.id)).toBeNull();
  });
});

// ---------- the feed, as a re-read enters and leaves an In progress view ----------

type FeedBody = { latest: number; entries: Array<{ id: number; kind: string; item?: { title: string; readCount: number | null } }> };

describe('an In progress view’s feed while a book is read again', () => {
  let keysA: Keys;
  let a: ReturnType<typeof instanceA>;
  let peer: Peer;
  beforeEach(async () => {
    keysA = await makeKeys();
    a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
    clearSharedViewsCache();
    await setUpA();
    peer = await makePeer('Riverbank library');
    await connectPeer(peer);
  });
  afterEach(() => vi.unstubAllGlobals());

  const pull = async (viewId: number, since: number) =>
    (await (await a.signedGet(`/federation/feed?view=${viewId}&since=${since}`, peer)).json()) as FeedBody;
  const invalid = async (viewId: number, ids: number[]) =>
    ((await (await a.signedPost('/federation/feed/check', peer, { view: viewId, ids })).json()) as { invalid: number[] }).invalid;
  const summary = (body: FeedBody) => body.entries.map((e) => `${e.kind} ${e.item?.title ?? ''}`.trim());

  /** A view of books being read, followed from a first page, and a book finished in 2019 once the follower has its cursor. */
  async function followed(again: Partial<Item> = {}) {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Main');
    const view = await createConnectionView(env.DB, { name: 'Reading now', libraryId: null, mediaType: 'book', status: 'in_progress', owned: null });
    const reading = await book(asha, { libraryId: shelf.id, title: 'Reading now', status: 'in_progress', beganOn: '2026-09-01' });
    await addProgress(env.DB, reading.id, 40, asha.id);
    const first = await pull(view.id, 0);
    expect(first.entries.length).toBeGreaterThan(0);
    // finished outside the view, after the follower's cursor: never served, and the cursor doesn't move
    const finished = await book(asha, { libraryId: shelf.id, title: 'Again', status: 'completed', beganOn: '2019-01-01', completedOn: '2019-02-01', ...again });
    const quiet = await pull(view.id, first.latest);
    expect(quiet.entries).toEqual([]);
    expect(quiet.latest).toBe(first.latest);
    return { asha, ravi, view, reading, again: finished, cursor: first.latest, held: first.entries.map((e) => e.id) };
  }

  it('the household’s stream: starting a re-read is no news, its pages are, and finishing takes them back', async () => {
    await upgradedSwitches(); // names off: the household's stream
    const { ravi, view, again, cursor, held } = await followed();

    await startRead(env.DB, again.id, today, ravi.id);
    const started = await pull(view.id, cursor);
    // the book is in the view now, but nothing about it is news: not its 2019 finish, recorded after the cursor
    expect(summary(started)).toEqual([]);
    expect(await invalid(view.id, held)).toEqual([]); // and nothing held is withdrawn

    await addProgress(env.DB, again.id, 30, ravi.id);
    const paged = await pull(view.id, started.latest);
    expect(summary(paged)).toEqual(['progress Again']);
    expect(paged.entries[0]!.item!.readCount).toBe(1); // a re-read's page, as the Feed tells them apart
    const page = paged.entries[0]!.id;

    await closeRead(env.DB, again.id, await openRead(again.id), 'completed', today, actor(ravi));
    const done = await pull(view.id, paged.latest);
    expect(summary(done)).toEqual([]); // finished: out of the view, as a first read's finish takes a book out
    expect(await invalid(view.id, [...held, page])).toEqual([page]); // its pages go with it, the rest stay
  });

  it('the per-person stream: a start is the only news, and a stop takes it back', async () => {
    const { asha, ravi, view, again, cursor, held } = await followed(); // a new instance: names on
    // Asha finishes a book today: her finish is recorded, outside the view, after the follower's cursor
    const hers = await book(asha, { libraryId: again.libraryId, title: 'Hers today', status: 'completed', beganOn: today, completedOn: today });
    expect(await rows("SELECT id FROM member_activity WHERE item_id = ?1 AND kind = 'finished'", hers.id)).toHaveLength(1);
    expect(summary(await pull(view.id, cursor))).toEqual([]);

    // Ravi starts it, and Asha reads hers again: both books are in the view now, and only the starts are news
    await startRead(env.DB, hers.id, today, ravi.id);
    await startRead(env.DB, again.id, today, ravi.id);
    const started = await pull(view.id, cursor);
    expect(summary(started)).toEqual(['started Hers today', 'started Again']);
    const [, start] = started.entries.map((e) => e.id);
    expect(await invalid(view.id, [...held, start!])).toEqual([]);

    await closeRead(env.DB, again.id, await openRead(again.id), 'abandoned', today, actor(ravi));
    expect(summary(await pull(view.id, started.latest))).toEqual([]);
    expect(await invalid(view.id, [...held, start!])).toEqual([start]);
  });

  it('a rating recorded while the book was outside the view arrives when it enters, as for a first read', async () => {
    await upgradedSwitches();
    const { asha, ravi, view, again, cursor } = await followed({ rating: 8 });
    // the same for a book never read: rated, then started — it entered the view the same way before §16 #64
    const unread = await book(asha, { libraryId: again.libraryId, title: 'Unread', rating: 6 });
    expect(summary(await pull(view.id, cursor))).toEqual([]);
    await startRead(env.DB, unread.id, today, asha.id);
    await startRead(env.DB, again.id, today, ravi.id);
    expect(summary(await pull(view.id, cursor)).sort()).toEqual(['rated Again', 'rated Unread']); // never 'finished Again'
  });

  it('a new follower’s first page carries a re-read’s pages, never the finish before it', async () => {
    await upgradedSwitches();
    const { ravi, view, again } = await followed({ rating: 8 });
    await startRead(env.DB, again.id, today, ravi.id);
    await addProgress(env.DB, again.id, 30, ravi.id);
    const fresh = await pull(view.id, 0);
    expect(summary(fresh).filter((s) => s.endsWith('Again')).sort()).toEqual(['progress Again', 'rated Again']);
  });

  it('a Completed view is untouched: a re-read starting or finishing is what it was', async () => {
    await upgradedSwitches();
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Main');
    const view = await createConnectionView(env.DB, { name: 'Read', libraryId: null, mediaType: 'book', status: 'completed', owned: null });
    const again = await book(asha, { libraryId: shelf.id, title: 'Again', status: 'completed', beganOn: '2019-01-01', completedOn: '2019-02-01' });
    const first = await pull(view.id, 0);
    expect(summary(first)).toEqual(['finished Again']);
    await startRead(env.DB, again.id, today, asha.id);
    expect(summary(await pull(view.id, first.latest))).toEqual([]);
    expect(await invalid(view.id, first.entries.map((e) => e.id))).toEqual([]);
    await closeRead(env.DB, again.id, await openRead(again.id), 'completed', today, actor(asha));
    expect(summary(await pull(view.id, first.latest))).toEqual(['finished Again']); // finished again: news, as ever
  });
});

// ---------- D1 calls ----------

describe('what the filter costs', () => {
  const calls = async (who: Member, path: string) => {
    const counter = { left: 1000 };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`http://nalanda.test${path}`, { headers: { cookie: who.cookie } }),
      { ...env, DB: budgeted(env.DB, counter) },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status, path).toBe(200);
    return 1000 - counter.left;
  };

  it('costs a shelf page no D1 call: In progress counts as Completed does, and as no filter', async () => {
    const { asha, shelf } = await household();
    const none = await calls(asha, `/libraries/${shelf.id}`);
    const byStatus = new Map<ItemStatus, number>();
    for (const status of ITEM_STATUSES) byStatus.set(status, await calls(asha, `/libraries/${shelf.id}?status=${status}`));
    expect(byStatus.get('in_progress')).toBe(none);
    expect(byStatus.get('completed')).toBe(none);
    expect(await calls(asha, `/libraries/${shelf.id}?status=in_progress&status=completed`)).toBe(none);
  });
});
