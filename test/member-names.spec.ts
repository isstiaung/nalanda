// Names outside the app, under the household's control (ARCH.md §16 #45): members' display names, two switches both off
// by default — share pages, and connections — and, with the connections one on, a feed entry per person. With both off
// nothing anyone outside sees changes; a login username never leaves the app, and nor do the dates of anyone's reads.
import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView, createSubscription, storeEntries, type NewRemoteActivity } from '../src/db/federation';
import {
  addPastRead,
  addProgress,
  createLibrary,
  createShare,
  deleteLibrary,
  deleteUser,
  mergeImportItems,
  setDisplayName,
  startRead,
  updateItemWithTags,
  updateSiteSettings,
} from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { MEMBER_ACTIVITY_BASE } from '../src/federation/config';
import { parseFeedEntry, parseItemDetail } from '../src/federation/items';
import { clearSharedViewsCache } from '../src/federation/routes';
import { normalizeDisplayName } from '../src/lib/names';
import { newShareToken } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import * as before from './fixtures/items-before-names';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, setUpA, sqlAgo, type Peer } from './federation-helpers';
import { as, book, member, rows, type Member } from './member-helpers';

const LOGINS = ['u-asha-login', 'u-ravi-login', 'u-mira-login'];
/** Starts and finishes reach the per-person log only as they happen (migration 0027), so the scene's happen today. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * A household of three: Asha (admin) and Ravi have display names, Mira has none. Asha and Ravi both finished
 * Piranesi today and reviewed it; Mira rated it without words and began reading it today, on page 40.
 */
async function scene() {
  const asha = await member(LOGINS[0]!, 'admin');
  const ravi = await member(LOGINS[1]!);
  const mira = await member(LOGINS[2]!);
  await setDisplayName(env.DB, asha.id, 'Asha');
  await setDisplayName(env.DB, ravi.id, 'Ravi K');
  const shelf = await createLibrary(env.DB, 'Fiction');
  const item = await book(asha, {
    libraryId: shelf.id,
    title: 'Piranesi',
    status: 'completed',
    beganOn: '2026-08-01',
    completedOn: today(),
    rating: 8,
    review: 'Hers: the tides.',
  });
  await addPastRead(env.DB, item.id, { status: 'completed', beganOn: '2026-08-20', endedOn: today() }, ravi.id);
  await updateItemWithTags(env.DB, item.id, {}, [], undefined, ravi.id, { rating: 5, review: 'His: the statues.' });
  await updateItemWithTags(env.DB, item.id, {}, [], undefined, mira.id, { rating: 7, review: null });
  await startRead(env.DB, item.id, today(), mira.id);
  await addProgress(env.DB, item.id, 40, mira.id);
  return { asha, ravi, mira, shelf, item };
}

/** Nothing a login username, or the date a read began, could show up as (the ends are today — as is every entry). */
function expectNoLoginsOrReadDates(text: string) {
  for (const login of LOGINS) expect(text, login).not.toContain(login);
  for (const date of ['2026-08-01', '2026-08-20']) expect(text, date).not.toContain(date);
}

// ---------- display names ----------

describe('display names', () => {
  it('are trimmed, single-spaced, stripped of control and format characters, and cut to 40 characters; empty is none', () => {
    expect(normalizeDisplayName('  Priya \n\t  R.  ')).toBe('Priya R.');
    expect(normalizeDisplayName('Ra‮vi​')).toBe('Ra vi');
    expect(normalizeDisplayName('x'.repeat(60))).toHaveLength(40);
    expect(normalizeDisplayName('   ')).toBeNull();
    expect(normalizeDisplayName('\u3164\u2800\u115F')).toBeNull(); // characters that look like nothing are nothing
    expect(normalizeDisplayName(undefined)).toBeNull();
  });

  it('are each member’s own to set on Account, anyone’s for an admin in Members, and never a login', async () => {
    const asha = await member('u-asha-login', 'admin');
    const ravi = await member('u-ravi-login');
    expect((await as(ravi, '/account/display-name', { body: { displayName: '  Ravi   K ' } })).status).toBe(302);
    expect((await rows<{ n: string }>('SELECT display_name AS n FROM users WHERE id = ?1', ravi.id))[0]!.n).toBe('Ravi K');
    expect(await (await as(ravi, '/account')).text()).toContain('value="Ravi K"');

    expect((await as(ravi, `/settings/users/${asha.id}/display-name`, { body: { displayName: 'Hacked' } })).status).toBe(403);
    expect((await as(asha, `/settings/users/${ravi.id}/display-name`, { body: { displayName: '' } })).status).toBe(302);
    expect((await rows<{ n: string | null }>('SELECT display_name AS n FROM users WHERE id = ?1', ravi.id))[0]!.n).toBeNull();

    // a display name signs nobody in
    await setDisplayName(env.DB, ravi.id, 'Ravi K');
    const login = await as(null, '/auth/login', { body: { username: 'Ravi K', password: 'whatever-password' } });
    expect(login.headers.get('set-cookie') ?? '').not.toContain('nalanda_session=');
  });
});

// ---------- with both switches off, nothing changes ----------

describe('with both switches off (the default), nothing anyone outside sees changes', () => {
  it('serves share pages byte for byte as without display names at all', async () => {
    const { item, shelf } = await scene();
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: shelf.id });
    const pages = async () => {
      clearSharePageCache();
      return [await (await as(null, `/share/${share.token}`)).text(), await (await as(null, `/share/${share.token}/items/${item.id}`)).text()];
    };
    const named = await pages();
    await env.DB.prepare('UPDATE users SET display_name = NULL').run();
    expect(await pages()).toEqual(named);
    for (const page of named) {
      expect(page).not.toContain('Asha');
      expect(page).not.toContain('Ravi K');
      expectNoLoginsOrReadDates(page);
    }
    expect(named[1]).toContain('<p class="eyebrow">Review</p>'); // one review, the household's latest, unsigned
  });

  it('records the household’s activity exactly as before: per-person triggers write only their own table', async () => {
    const replay = async (withMemberTriggers: boolean) => {
      await reset();
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
      if (!withMemberTriggers) {
        for (const t of ['reads_ai', 'reads_au', 'reviews_ai', 'reviews_au', 'progress_ai']) await env.DB.prepare(`DROP TRIGGER member_activity_${t}`).run();
      }
      await createConnectionView(env.DB, { name: 'All', libraryId: null, mediaType: null, status: null, owned: null });
      await scene();
      const log = await rows<{ id: number; item_id: number; kind: string; at: string; progress_id: number | null }>(
        'SELECT id, item_id, kind, substr(at, 1, 10) AS at, progress_id FROM activity_log ORDER BY id',
      );
      const members = (await rows<{ n: number }>('SELECT count(*) AS n FROM member_activity'))[0]!.n;
      return { log, members };
    };
    const withThem = await replay(true);
    const without = await replay(false);
    expect(withThem.members).toBeGreaterThan(0); // negative control: the per-person log did record
    expect(without.members).toBe(0);
    expect(withThem.log).toEqual(without.log); // ids and all
  });

  describe('to connections', () => {
    let a: ReturnType<typeof instanceA>;
    let peer: Peer;
    let viewId: number;
    beforeEach(async () => {
      const keys = await makeKeys();
      a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
      clearSharedViewsCache();
      await setUpA();
      peer = await makePeer('Riverbank library');
      await connectPeer(peer);
      viewId = (await createConnectionView(env.DB, { name: 'All', libraryId: null, mediaType: null, status: null, owned: null })).id;
    });
    afterEach(() => vi.unstubAllGlobals());

    it('serves the feed and item pages byte for byte as without display names or the per-person log', async () => {
      const { item } = await scene();
      const served = async () => [
        await (await a.signedGet(`/federation/feed?view=${viewId}&since=0`, peer)).text(),
        await (await a.signedGet(`/federation/item?view=${viewId}&id=${item.id}`, peer)).text(),
      ];
      const now = await served();
      await env.DB.batch([env.DB.prepare('UPDATE users SET display_name = NULL'), env.DB.prepare('DELETE FROM member_activity')]);
      expect(await served()).toEqual(now);
      const [feed, detail] = now;
      expect(JSON.parse(feed!).entries.map((e: { kind: string }) => e.kind).sort()).toEqual(['finished', 'progress', 'rated', 'reviewed']);
      expect(JSON.parse(feed!).entries.every((e: { id: number; item: object }) => e.id < MEMBER_ACTIVITY_BASE && !('by' in e.item))).toBe(true);
      expect(JSON.parse(detail!)).not.toHaveProperty('reviews');
      for (const text of now) {
        expect(text).not.toContain('Asha');
        expect(text).not.toContain('Ravi K');
        for (const login of LOGINS) expect(text).not.toContain(login);
      }
    });
  });
});

// ---------- share pages with names on ----------

describe('share pages with names on', () => {
  it('show everyone’s rating and review by display name, unnamed members unsigned — never a login or a read’s date', async () => {
    const { item, shelf, asha } = await scene();
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: shelf.id });
    expect((await as(asha, '/shares/settings', { body: { setting: 'names', namesOnShares: 'on' } })).status).toBe(302);
    const page = async () => {
      clearSharePageCache();
      return (await as(null, `/share/${share.token}/items/${item.id}`)).text();
    };
    const html = await page();
    expect(html).toContain('<p class="eyebrow">Ratings and reviews</p>');
    expect(html).toContain('<span class="reviewer">Asha</span>');
    expect(html).toContain('<span class="reviewer">Ravi K</span>');
    expect(html).toContain('Hers: the tides.');
    expect(html).toContain('His: the statues.');
    expect(html.match(/<span class="reviewer">/g)).toHaveLength(2); // Mira's rating is there, unsigned
    expect(html).toContain('★★★½'); // her 7
    expect(html).toContain('2 times'); // reading history stays a nameless count
    expectNoLoginsOrReadDates(html);

    // renaming or removing a member changes what the next render shows
    await setDisplayName(env.DB, asha.id, 'A. R.');
    expect(await page()).toContain('<span class="reviewer">A. R.</span>');
    await deleteUser(env.DB, (await rows<{ id: number }>("SELECT id FROM users WHERE username = 'u-ravi-login'"))[0]!.id);
    const after = await page();
    expect(after).not.toContain('Ravi K');
    expect(after).toContain('His: the statues.'); // still there, unsigned

    // and switching off hides every name from the next render
    expect((await as(asha, '/shares/settings', { body: { setting: 'names' } })).status).toBe(302);
    const off = await page();
    expect(off).not.toContain('reviewer');
    expect(off).not.toContain('A. R.');
  });

  it('switch only from its own form, only for an admin, and leave progress on shares alone', async () => {
    const asha = await member('u-asha-login', 'admin');
    const ravi = await member('u-ravi-login');
    await updateSiteSettings(env.DB, { progressOnShares: true });
    expect((await as(ravi, '/shares/settings', { body: { setting: 'names', namesOnShares: 'on' } })).status).toBe(403);
    await as(asha, '/shares/settings', { body: { setting: 'names', namesOnShares: 'on' } });
    const settings = (await rows<{ p: number; n: number; c: number }>('SELECT progress_on_shares AS p, names_on_shares AS n, names_to_connections AS c FROM site_settings'))[0]!;
    expect(settings).toEqual({ p: 1, n: 1, c: 0 });
    const shares = await (await as(asha, '/shares')).text();
    expect(shares).toContain('name="namesOnShares" value="on" checked');
  });
});

// ---------- connections with names on ----------

describe('connections with names on', () => {
  let a: ReturnType<typeof instanceA>;
  let peer: Peer;
  let viewId: number;
  beforeEach(async () => {
    const keys = await makeKeys();
    a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
    clearSharedViewsCache();
    await setUpA();
    peer = await makePeer('Riverbank library');
    await connectPeer(peer);
    viewId = (await createConnectionView(env.DB, { name: 'All', libraryId: null, mediaType: null, status: null, owned: null })).id;
  });
  afterEach(() => vi.unstubAllGlobals());

  type Entry = {
    id: number;
    kind: string;
    published: string;
    item: { by?: string; rating: number | null; review: string | null; progress: { page: number } | null; readCount: number };
  };
  const pull = async (since = 0) =>
    (await (await a.signedGet(`/federation/feed?view=${viewId}&since=${since}`, peer)).json()) as { latest: number; entries: Entry[] };
  const check = async (ids: number[]) =>
    (await (await a.signedPost('/federation/feed/check', peer, { view: viewId, ids })).json()) as { invalid: number[] };
  const lines = (entries: Entry[]) => entries.map((e) => `${e.item.by ?? '(unnamed)'} ${e.kind}${e.item.rating ? ` ${e.item.rating}` : ''}${e.item.review ? ` "${e.item.review}"` : ''}${e.item.progress ? ` p.${e.item.progress.page}` : ''}`).sort();

  it('give one entry per person, signed with display names, each with that member’s own rating and review', async () => {
    const { asha } = await scene();
    expect((await a.postForm('/connections/names-sharing', { namesToConnections: 'on' }, asha.cookie)).status).toBe(302);
    const page = await pull();
    expect(lines(page.entries)).toEqual([
      '(unnamed) progress p.40',
      '(unnamed) rated 7',
      '(unnamed) started',
      'Asha finished',
      'Asha rated 8',
      'Asha reviewed "Hers: the tides."',
      'Ravi K finished', // two people finishing the same book: two entries
      'Ravi K rated 5',
      'Ravi K reviewed "His: the statues."',
    ]);
    expect(page.entries.every((e) => e.id > MEMBER_ACTIVITY_BASE)).toBe(true);
    // each finish counts that member's own reads: a first read isn't "finished again" because the other read it too
    expect(page.entries.filter((e) => e.kind === 'finished').map((e) => e.item.readCount)).toEqual([1, 1]);
    const text = JSON.stringify(page);
    for (const login of LOGINS) expect(text).not.toContain(login);
    expectNoLoginsOrReadDates(text);
  });

  it('record a past read added later, or a rating of 0, as nothing — and leave a 0 off the item page', async () => {
    const { item, mira } = await scene();
    await updateSiteSettings(env.DB, { namesToConnections: true });
    const before = await pull();
    await addPastRead(env.DB, item.id, { status: 'completed', beganOn: '2026-07-01', endedOn: '2026-07-20' }, mira.id);
    const extra = await member('u-extra-login');
    await setDisplayName(env.DB, extra.id, 'Zero');
    await updateItemWithTags(env.DB, item.id, {}, [], undefined, extra.id, { rating: 0, review: null });
    expect((await pull(before.latest)).entries).toEqual([]);
    const detail = (await (await a.signedGet(`/federation/item?view=${viewId}&id=${item.id}`, peer)).json()) as { reviews: { by: string | null }[] };
    expect(detail.reviews.map((r) => r.by)).not.toContain('Zero');
  });

  it('reach what a connection already holds when a member is renamed or removed: old entries withdrawn, new ones pulled', async () => {
    const { ravi, asha } = await scene();
    await updateSiteSettings(env.DB, { namesToConnections: true });
    const first = await pull();
    const his = first.entries.filter((e) => e.item.by === 'Ravi K').map((e) => e.id);
    const hers = first.entries.filter((e) => e.item.by === 'Asha').map((e) => e.id);
    expect(his).toHaveLength(3);

    await setDisplayName(env.DB, ravi.id, 'R. K.');
    expect((await check([...his, ...hers])).invalid.sort()).toEqual([...his].sort()); // his withdrawn, hers stand
    const renamed = await pull(first.latest);
    expect(lines(renamed.entries)).toEqual(['R. K. finished', 'R. K. rated 5', 'R. K. reviewed "His: the statues."']);
    expect(renamed.entries.map((e) => e.published).sort()).toEqual(first.entries.filter((e) => his.includes(e.id)).map((e) => e.published).sort()); // dated as before

    await setDisplayName(env.DB, ravi.id, 'R. K.'); // the same name again: nothing to withdraw
    expect((await pull(renamed.latest)).entries).toEqual([]);

    await deleteUser(env.DB, ravi.id);
    expect((await check(renamed.entries.map((e) => e.id))).invalid).toHaveLength(3);
    const removed = await pull(renamed.latest);
    expect(lines(removed.entries)).toEqual(['(unnamed) finished', '(unnamed) rated 5', '(unnamed) reviewed "His: the statues."']); // kept, unsigned
    expect(JSON.stringify(await pull())).not.toMatch(/R\. K\.|Ravi/);
    expect(hers.length).toBeGreaterThan(0);
    expect(asha.id).toBeGreaterThan(0);
  });

  it('switch streams cleanly both ways, withdrawing named entries once names go off', async () => {
    const { asha } = await scene();
    const household = await pull();
    expect(household.entries.every((e) => e.id < MEMBER_ACTIVITY_BASE)).toBe(true);

    await updateSiteSettings(env.DB, { namesToConnections: true });
    const named = await pull(household.latest); // a household cursor: the named stream starts from its newest
    expect(named.entries.length).toBe(9);
    expect(named.latest).toBeGreaterThan(MEMBER_ACTIVITY_BASE);
    expect((await pull(named.latest)).entries).toEqual([]); // and then carries on from its own cursor
    const namedIds = named.entries.map((e) => e.id);
    const householdIds = household.entries.map((e) => e.id);
    // on: the household's entries are withdrawn, so no one sees an event twice, once unsigned and once by name
    expect((await check([...namedIds, ...householdIds])).invalid.sort()).toEqual([...householdIds].sort());

    await a.postForm('/connections/names-sharing', {}, asha.cookie); // off
    expect((await check([...namedIds, ...householdIds])).invalid.sort()).toEqual([...namedIds].sort()); // named: withdrawn
    const back = await pull(named.latest); // a named cursor: the household stream starts again from its newest
    expect(back.entries.map((e) => e.id).sort()).toEqual([...householdIds].sort());
    expect(JSON.stringify(back)).not.toContain('Asha');
  });

  it('list everyone’s rating and review on an item page, by display name or unsigned', async () => {
    const { item } = await scene();
    await updateSiteSettings(env.DB, { namesToConnections: true });
    const detail = (await (await a.signedGet(`/federation/item?view=${viewId}&id=${item.id}`, peer)).json()) as { reviews: unknown[]; rating: number };
    expect(detail.rating).toBe(7); // the household's average, as ever
    expect(detail.reviews).toEqual([
      { by: 'Ravi K', rating: 5, review: 'His: the statues.' },
      { by: 'Asha', rating: 8, review: 'Hers: the tides.' },
      { by: null, rating: 7, review: null },
    ]);
    const text = JSON.stringify(detail);
    for (const login of LOGINS) expect(text).not.toContain(login);
  });

  it('never make an import’s old reads news: they are dated by when they happened, or not recorded', async () => {
    const asha = await member('u-asha-login', 'admin');
    const item = await book(asha, { title: 'Kindred', creators: 'Octavia E. Butler' });
    await mergeImportItems(env.DB, [
      {
        item: { libraryId: item.libraryId, title: 'Kindred', creators: 'Octavia E. Butler', rating: 8, addedBy: asha.id },
        tags: [],
        goodreads: { shelf: 'completed', dateRead: '2019-05-01', dateStarted: null, readCount: 2 },
      },
    ]);
    const recorded = await rows<{ kind: string; at: string }>('SELECT kind, at FROM member_activity ORDER BY id');
    expect(recorded).toEqual([
      { kind: 'rated', at: '2019-05-01 00:00:00' }, // by the book's last finish, as the household's rating is; its reads: nothing
    ]);
  });
});

// ---------- a shelf deleted with the last view ----------

describe('deleting a shelf that takes the last connection view with it', () => {
  it('clears both activity logs, as removing the last view does — but not while another view remains', async () => {
    const run = async (otherView: boolean) => {
      await reset();
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
      const { shelf } = await (async () => {
        const s = await createLibrary(env.DB, 'Just this shelf');
        await createConnectionView(env.DB, { name: 'Shelf', libraryId: s.id, mediaType: null, status: null, owned: null });
        if (otherView) await createConnectionView(env.DB, { name: 'All', libraryId: null, mediaType: null, status: null, owned: null });
        const asha = await member('u-asha-login', 'admin');
        await book(asha, { libraryId: s.id, title: 'Piranesi', status: 'completed', completedOn: today(), rating: 8, review: 'Yes' });
        // and one on another shelf: with no view left, its entries are as stale as the deleted shelf's
        await book(asha, { title: 'Kindred', status: 'completed', completedOn: today(), rating: 6, review: 'Also' });
        return { shelf: s };
      })();
      const counts = async () =>
        (await rows<{ h: number; m: number }>('SELECT (SELECT count(*) FROM activity_log) AS h, (SELECT count(*) FROM member_activity) AS m'))[0]!;
      const recorded = await counts();
      await deleteLibrary(env.DB, shelf.id);
      return { recorded, after: await counts() };
    };
    const alone = await run(false);
    expect(alone.recorded.h).toBeGreaterThan(0);
    expect(alone.recorded.m).toBeGreaterThan(0);
    expect(alone.after).toEqual({ h: 0, m: 0 });
    const withOther = await run(true);
    expect(withOther.after.h).toBeGreaterThan(0); // both logs stay while a view remains
    expect(withOther.after.m).toBeGreaterThan(0);
  });
});

// ---------- the protocol, both ways ----------

describe('the protocol stays version 1: additive, optional fields only', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: 5, mediaType: 'book', title: 'Piranesi', creators: null, published: null, coverKey: null, rating: 6, review: null,
    reviewTruncated: false, inCollection: true, completedOn: null, stamp: '0123456789abcdef', progress: null, readCount: 1, ...over,
  });
  const entry = (kind: string, over: Record<string, unknown> = {}) => ({ id: MEMBER_ACTIVITY_BASE + 3, kind, published: sqlAgo(5), item: item(over) });

  it('lets a household on an older version read named entries — without the name — and skip "started"', () => {
    const named = before.parseFeedEntry(entry('rated', { by: 'Asha' }));
    expect(named).toMatchObject({ kind: 'rated', item: { rating: 6 } });
    expect(named!.item).not.toHaveProperty('by');
    expect(before.parseFeedEntry(entry('started', { by: 'Asha' }))).toBeNull(); // dropped, not the page
    const detail = { ...item(), publisher: null, description: null, length: null, details: {}, updatedAt: sqlAgo(1), available: true, tags: [], reviews: [{ by: 'Asha', rating: 8, review: 'x' }] };
    expect(before.parseItemDetail(detail)).toMatchObject({ title: 'Piranesi' });
    expect(before.parseItemDetail(detail)).not.toHaveProperty('reviews');
  });

  it('reads an older household’s entries and pages as before, and a newer one’s names — rejecting a malformed name', () => {
    expect(parseFeedEntry(entry('finished'))!.item).not.toHaveProperty('by');
    expect(parseFeedEntry(entry('finished', { by: 'Priya' }))!.item.by).toBe('Priya');
    expect(parseFeedEntry(entry('started', { by: 'Priya' }))!.kind).toBe('started');
    expect(parseFeedEntry(entry('finished', { by: 42 }))).toBeNull();
    expect(parseFeedEntry(entry('finished', { by: 'x'.repeat(81) }))).toBeNull();
    expect(parseFeedEntry(entry('finished', { by: 'Pri‮ya' }))!.item.by).toBe('Pri ya'); // no text reordering
    const detail = { ...item(), publisher: null, description: null, length: null, details: {}, updatedAt: sqlAgo(1), available: true, tags: [] };
    expect(parseItemDetail(detail)).not.toHaveProperty('reviews');
    expect(parseItemDetail({ ...detail, reviews: [{ by: 'Priya', rating: 8, review: 'Yes' }, { rating: 4 }] })!.reviews).toEqual([
      { by: 'Priya', rating: 8, review: 'Yes' },
      { by: null, rating: 4, review: null },
    ]);
    expect(parseItemDetail({ ...detail, reviews: [{ by: 'Priya', rating: 11 }] })).toBeNull();
  });
});

// ---------- names others send, on our pages ----------

describe('names another household sends', () => {
  let a: ReturnType<typeof instanceA>;
  let connectionId: number;
  beforeEach(async () => {
    const keys = await makeKeys();
    a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
    await setUpA();
    connectionId = (await connectPeer(await makePeer('Riverbank library'))).id;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('render as escaped text, a card per person, on the Feed', async () => {
    answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/feed/check' ? json({ invalid: [], viewGone: false }) : json({ view: 7, latest: 0, more: false, entries: [] }),
    );
    const sub = (await createSubscription(env.DB, { connectionId, viewId: 7, viewName: 'Read', intervalMinutes: 60, retentionDays: 90, maxEntries: 500 }))!.id;
    const stored = (remoteId: number, kind: string, over: Record<string, unknown>): NewRemoteActivity => {
      const body = JSON.stringify({
        id: 5, mediaType: 'book', title: 'Piranesi', creators: null, published: null, coverKey: null, rating: null, review: null,
        reviewTruncated: false, inCollection: true, completedOn: null, stamp: '0123456789abcdef', progress: null, readCount: 1, ...over,
      });
      return { remoteId, itemRemoteId: 5, itemStamp: '0123456789abcdef', kind: kind as NewRemoteActivity['kind'], publishedAt: sqlAgo(remoteId), item: body, bytes: body.length };
    };
    await storeEntries(env.DB, sub, [
      stored(1, 'finished', { by: 'Priya' }),
      stored(2, 'finished', { by: '<script>alert(1)</script>' }),
      stored(3, 'started', { by: 'Dev' }),
    ]);
    const member = await (await import('./federation-helpers')).sessionCookie('member');
    const html = (await (await a.get('/feed', member)).text()).replace(/\s+/g, ' ');
    expect(html).toContain('<span class="feed-by">Priya </span><span class="muted">finished</span> <strong>Piranesi');
    expect(html).toContain('<span class="feed-by">Dev </span><span class="muted">started</span>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('give a book one comment thread, under the first card that reviews it, however many people reviewed it', async () => {
    answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/feed/check' ? json({ invalid: [], viewGone: false }) : json({ view: 7, latest: 0, more: false, entries: [] }),
    );
    const sub = (await createSubscription(env.DB, { connectionId, viewId: 7, viewName: 'Read', intervalMinutes: 60, retentionDays: 90, maxEntries: 500 }))!.id;
    const stored = (remoteId: number, over: Record<string, unknown>): NewRemoteActivity => {
      const body = JSON.stringify({
        id: 5, mediaType: 'book', title: 'Piranesi', creators: null, published: null, coverKey: null, rating: null, review: null,
        reviewTruncated: false, inCollection: true, completedOn: null, stamp: '0123456789abcdef', progress: null, readCount: 1, ...over,
      });
      return { remoteId, itemRemoteId: 5, itemStamp: '0123456789abcdef', kind: 'reviewed', publishedAt: sqlAgo(remoteId), item: body, bytes: body.length };
    };
    await storeEntries(env.DB, sub, [stored(1, { by: 'Priya', review: 'Hers' }), stored(2, { by: 'Dev', review: 'His' })]);
    const member = await (await import('./federation-helpers')).sessionCookie('member');
    const html = await (await a.get('/feed', member)).text();
    expect(html).toContain('Hers');
    expect(html).toContain('His');
    expect(html.match(/<details class="thread"/g)).toHaveLength(1);
    expect(html.match(/id="thread-/g)).toHaveLength(1); // and so one element with that id
  });

  it('render as escaped text on their item page', async () => {
    answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/item'
        ? json({
            id: 70, mediaType: 'book', title: 'Free one', creators: null, publisher: null, published: null, description: null, length: null,
            coverKey: null, rating: 7, review: null, inCollection: true, details: {}, completedOn: null, updatedAt: '2026-09-01 10:00:00',
            available: false, tags: [], stamp: '0123456789abcdef',
            reviews: [{ by: '<img src=x onerror=alert(1)>', rating: 8, review: 'Good' }, { by: null, rating: 6, review: null }],
          })
        : json({}, 404),
    );
    const member = await (await import('./federation-helpers')).sessionCookie('member');
    const html = await (await a.get(`/households/${connectionId}/views/7/items/70`, member)).text();
    expect(html).toContain('Their ratings and reviews');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('<span class="reviewer">A member</span>');
  });
});

// ---------- the D1 budget ----------

describe('D1 calls, with names on and several members', () => {
  async function count(path: string, bindings: Record<string, unknown> = {}, signer?: { a: ReturnType<typeof instanceA>; peer: Peer }) {
    const budget = { left: 1000 };
    if (signer) {
      const counted = instanceA({ ...env, ...bindings, DB: budgeted(env.DB, budget) } as Bindings);
      const res = await counted.signedGet(path, signer.peer);
      return { status: res.status, calls: 1000 - budget.left };
    }
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://nalanda.test${path}`), { ...env, DB: budgeted(env.DB, budget) }, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, calls: 1000 - budget.left };
  }
  const moreMembers = async (itemId: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const m: Member = await member(`u-extra-${i}`);
      await setDisplayName(env.DB, m.id, `Extra ${i}`);
      await updateItemWithTags(env.DB, itemId, {}, [], undefined, m.id, { rating: 6, review: `Review ${i}` });
      await addPastRead(env.DB, itemId, { status: 'completed', beganOn: null, endedOn: '2026-09-01' }, m.id);
    }
  };

  it('keep a share page well inside the budget', async () => {
    const { item, shelf } = await scene();
    await moreMembers(item.id, 6);
    await updateSiteSettings(env.DB, { namesOnShares: true });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: shelf.id });
    clearSharePageCache();
    const result = await count(`/share/${share.token}/items/${item.id}`);
    expect(result.status).toBe(200);
    expect(result.calls).toBeLessThanOrEqual(6);
  });

  it('keep a feed pull well inside the budget', async () => {
    const keys = await makeKeys();
    clearSharedViewsCache();
    await setUpA();
    const peer = await makePeer('Riverbank library');
    await connectPeer(peer);
    const view = await createConnectionView(env.DB, { name: 'All', libraryId: null, mediaType: null, status: null, owned: null });
    const { item } = await scene();
    await moreMembers(item.id, 6);
    await updateSiteSettings(env.DB, { namesToConnections: true });
    const signer = { a: instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings), peer };
    const result = await count(`/federation/feed?view=${view.id}&since=0`, { FEDERATION_PRIVATE_KEY: keys.secret }, signer);
    expect(result.status).toBe(200);
    expect(result.calls).toBeLessThanOrEqual(10);
  });
});
