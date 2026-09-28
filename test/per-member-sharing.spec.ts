// Who read what stays inside the household (ARCH.md §16 #43): the shelf's "Read by" filter, which no share link or
// connection view can capture, and the household summary — average rating, latest review, total finishes — that
// share pages and connections see instead of anyone's name.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView, getConnectionView } from '../src/db/federation';
import {
  addPastRead,
  addProgress,
  countMatchingItems,
  createLibrary,
  createShare,
  listItems,
  mergeImportItems,
  startRead,
  updateSiteSettings,
} from '../src/db/queries';
import type { Bindings } from '../src/env';
import { clearSharedViewsCache } from '../src/federation/routes';
import { itemMatchesShare, newShareToken, shareFilters } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import { connectPeer, instanceA, makeKeys, makePeer, setUpA, type Peer } from './federation-helpers';
import { as, book, html, member, rows, summaryOf, type Member } from './member-helpers';

async function shelfOfFour() {
  const asha = await member('asha', 'admin');
  const ravi = await member('ravi');
  const shelf = await createLibrary(env.DB, 'Fiction');
  const on = { libraryId: shelf.id };
  const both = await book(asha, { ...on, title: 'Both finished', status: 'completed', completedOn: '2020-01-01' });
  await addPastRead(env.DB, both.id, { status: 'completed', beganOn: null, endedOn: '2021-01-01' }, ravi.id);
  const hers = await book(asha, { ...on, title: 'Only Asha finished', status: 'completed', completedOn: '2020-02-01' });
  const his = await book(ravi, { ...on, title: 'Only Ravi finished', status: 'completed', completedOn: '2020-03-01' });
  const reading = await book(null, { ...on, title: 'Ravi reading now' });
  await startRead(env.DB, reading.id, '2026-09-01', ravi.id);
  const nobody = await book(null, { ...on, title: 'Nobody yet' });
  return { asha, ravi, shelf, both, hers, his, reading, nobody };
}

const titles = (page: string) => [...page.matchAll(/<a href="\/items\/\d+" title="([^"]+)"/g)].map((m) => m[1]).sort();

// ---------- the Read by filter ----------

describe('the Read by filter on a shelf', () => {
  it('narrows to what someone finished, didn’t finish, or is reading now', async () => {
    const s = await shelfOfFour();
    const shelf = (q: string, who: Member = s.asha) => html(who, `/libraries/${s.shelf.id}${q}`).then(titles);

    expect(await shelf('')).toHaveLength(5); // negative control: no filter, everything
    expect(await shelf('?readBy=me')).toEqual(['Both finished', 'Only Asha finished']);
    expect(await shelf('?readBy=not-me')).toEqual(['Nobody yet', 'Only Ravi finished', 'Ravi reading now']);
    expect(await shelf(`?readBy=${s.ravi.id}`)).toEqual(['Both finished', 'Only Ravi finished']);
    expect(await shelf('?readBy=anyone')).toEqual(['Both finished', 'Only Asha finished', 'Only Ravi finished']);
    expect(await shelf(`?readBy=now-${s.ravi.id}`)).toEqual(['Ravi reading now']);
    expect(await shelf('?readBy=now-me', s.ravi)).toEqual(['Ravi reading now']);
    expect(await shelf('?readBy=me', s.ravi)).toEqual(['Both finished', 'Only Ravi finished']);
    // a filter that names nobody here is no filter
    expect(await shelf('?readBy=999999')).toHaveLength(5);
    // and it keeps its place across pages and the Covers view
    expect(await html(s.asha, `/libraries/${s.shelf.id}?readBy=me`)).toContain('readBy=me&amp;view=grid');
  });

  it('works in the database layer and in search, and composes with the other filters', async () => {
    const s = await shelfOfFour();
    const { items } = await listItems(env.DB, s.shelf.id, { statuses: ['completed'] }, { readerId: s.ravi.id, mode: 'unfinished' });
    expect(items.map((i) => i.title)).toEqual(['Only Asha finished']);
    const found = await html(s.asha, `/search?q=finished&readBy=${s.ravi.id}`);
    expect(titles(found)).toEqual(['Both finished', 'Only Ravi finished']);
    expect(titles(await html(s.asha, '/search?q=finished'))).toHaveLength(3); // negative control
  });

  it('is offered once the household has more than one member, and not to a household of one', async () => {
    const solo = await member('solo', 'admin');
    const shelf = await createLibrary(env.DB, 'Mine');
    await book(solo, { libraryId: shelf.id });
    expect(await html(solo, `/libraries/${shelf.id}`)).not.toContain('name="readBy"');
    expect(await html(solo, '/search?q=x')).not.toContain('name="readBy"');
    const ravi = await member('ravi');
    const page = await html(solo, `/libraries/${shelf.id}`);
    expect(page).toContain('<select name="readBy" aria-label="Read by">');
    expect(page).toContain(`<option value="${ravi.id}">Read by ravi</option>`);
  });
});

describe('the Read by filter can never be published', () => {
  it('has no field in the shelf’s publish form, and says so', async () => {
    const s = await shelfOfFour();
    const page = await html(s.asha, `/libraries/${s.shelf.id}?readBy=me&status=completed`);
    const publish = page.slice(page.indexOf('action="/shares"'), page.indexOf('Publish current view'));
    expect(publish).toContain('name="status" value="completed"'); // negative control: the captured filter is there
    expect(publish).not.toContain('readBy');
    expect(page).toContain('&quot;Read by&quot; is never published');
  });

  it('is dropped from a publish request that sends it anyway: the link shows the view without it', async () => {
    const s = await shelfOfFour();
    const res = await as(s.asha, '/shares', { body: { libraryId: String(s.shelf.id), name: 'Ours', status: 'completed', readBy: 'me', reader: String(s.asha.id) } });
    expect(res.status).toBe(302);
    const [share] = await rows<Record<string, unknown>>('SELECT * FROM shares');
    expect(Object.keys(share!).filter((k) => /read/i.test(k))).toEqual([]); // nowhere to keep it
    clearSharePageCache();
    const pub = await (await as(null, `/share/${share!.token}`)).text();
    for (const t of ['Both finished', 'Only Asha finished', 'Only Ravi finished']) expect(pub).toContain(t);
  });

  it('can’t reach a share view’s filters or its item guard', async () => {
    const s = await shelfOfFour();
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: s.shelf.id, status: 'completed' });
    expect(Object.keys(shareFilters(share)).sort()).toEqual(['mediaTypes', 'owned', 'sort', 'statuses', 'tag']);
    expect(itemMatchesShare(share, s.his, [])).toBe(true); // finished by ravi only: still in the view, for anyone
    expect(await countMatchingItems(env.DB, s.shelf.id, shareFilters(share))).toBe(3);
  });

  describe('connection views', () => {
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

    it('keeps no reader when a view is shared, and serves everything in it', async () => {
      const s = await shelfOfFour();
      const res = await a.postForm('/connections/views', { name: 'Finished', libraryId: String(s.shelf.id), status: 'completed', readBy: 'me' }, s.asha.cookie);
      expect(res.status).toBe(302);
      const [view] = await rows<Record<string, unknown>>('SELECT * FROM connection_views');
      expect(Object.keys(view!).filter((k) => /read/i.test(k))).toEqual([]);
      const shelf = (await (await a.signedGet(`/federation/shelf?view=${view!.id}`, peer)).json()) as { items: Array<{ title: string }> };
      expect(shelf.items.map((i) => i.title).sort()).toEqual(['Both finished', 'Only Asha finished', 'Only Ravi finished']);
      expect(await getConnectionView(env.DB, view!.id as number)).toMatchObject({ status: 'completed' });
    });
  });
});

// ---------- the household summary, in public ----------

async function reviewedTwice() {
  const asha = await member('asha', 'admin');
  const ravi = await member('ravi');
  const item = await book(asha, { title: 'The Left Hand of Darkness', status: 'completed', completedOn: '2020-01-01', rating: 8, review: 'Her words about winter.' });
  await env.DB.prepare("UPDATE reviews SET reviewed_at = '2020-01-02 00:00:00'").run();
  await addPastRead(env.DB, item.id, { status: 'completed', beganOn: null, endedOn: '2024-06-01' }, ravi.id);
  const edit = await as(ravi, `/items/${item.id}`, {
    body: { libraryId: String(item.libraryId), title: item.title, mediaType: 'book', status: 'completed', beganOn: '', completedOn: '2024-06-01', rating: '5', review: 'His words about the ice.' },
  });
  expect(edit.status).toBe(302);
  return { asha, ravi, item };
}

describe('share pages show the household, never a person', () => {
  it('show the average rating, the latest review, and everyone’s finishes — with no names', async () => {
    const { item } = await reviewedTwice();
    expect(await summaryOf(item.id)).toMatchObject({ rating: 7, review: 'His words about the ice.', readCount: 2 });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: item.libraryId });
    clearSharePageCache();
    const listing = await (await as(null, `/share/${share.token}`)).text();
    const page = await (await as(null, `/share/${share.token}/items/${item.id}`)).text();
    expect(page).toContain('His words about the ice.');
    expect(page).not.toContain('Her words about winter.'); // one review in public: the latest
    expect(page).toContain('★★★½'); // 6.5 → 7 half-stars
    expect(page).toContain('2 times');
    for (const text of [listing, page]) {
      expect(text).not.toContain('asha');
      expect(text).not.toContain('ravi');
      expect(text).not.toContain('2024-06-01');
    }
  });

  it('show progress, when switched on, as the latest page anyone reading it now recorded', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const item = await book(null);
    await updateSiteSettings(env.DB, { progressOnShares: true });
    await addProgress(env.DB, item.id, 40, asha.id);
    await env.DB.prepare("UPDATE reading_progress SET at = '2026-09-01 10:00:00'").run();
    await addProgress(env.DB, item.id, 210, ravi.id);
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: item.libraryId });
    clearSharePageCache();
    const page = await (await as(null, `/share/${share.token}/items/${item.id}`)).text();
    expect(page).toContain('p. 210');
    expect(page).not.toContain('p. 40');
  });
});

describe('connections see the household, never a person', () => {
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

  it('serve the summary on an item page and in the feed, with no member’s name anywhere', async () => {
    const view = await createConnectionView(env.DB, { name: 'Everything', libraryId: null, mediaType: null, status: null, owned: null });
    const { item } = await reviewedTwice();
    const detail = await (await a.signedGet(`/federation/item?view=${view.id}&id=${item.id}`, peer)).text();
    expect(JSON.parse(detail)).toMatchObject({ rating: 7, review: 'His words about the ice.', readCount: 2, completedOn: '2024-06-01' });
    const feed = await (await a.signedGet(`/federation/feed?view=${view.id}&since=0`, peer)).text();
    expect(JSON.parse(feed).entries.map((e: { kind: string }) => e.kind).sort()).toEqual(['finished', 'rated', 'reviewed']);
    for (const text of [detail, feed]) {
      expect(text).not.toContain('asha');
      expect(text).not.toContain('ravi');
      expect(text).not.toContain('Her words about winter.');
    }
  });

  it('record "rated" when a second member moves the average, and nothing when the average stays', async () => {
    await createConnectionView(env.DB, { name: 'Everything', libraryId: null, mediaType: null, status: null, owned: null });
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const mira = await member('mira');
    const item = await book(asha, { rating: 8 });
    const rated = () => rows<{ id: number; at: string }>("SELECT id, at FROM activity_log WHERE item_id = ?1 AND kind = 'rated'", item.id);
    const first = await rated();
    expect(first).toHaveLength(1);

    const rate = (who: Member, rating: string) =>
      as(who, `/items/${item.id}`, { body: { libraryId: String(item.libraryId), title: item.title, mediaType: 'book', rating, status: 'not_started' } });
    await rate(ravi, '6'); // (8 + 6) / 2 = 7: the book's rating moved — news, today
    const second = await rated();
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first[0]!.id);
    expect(Date.now() - Date.parse(`${second[0]!.at.replace(' ', 'T')}Z`)).toBeLessThan(5 * 60_000);

    await rate(mira, '7'); // (8 + 6 + 7) / 3 = 7: no change in public, nothing recorded
    expect(await rated()).toEqual(second);
  });

  it('don’t hear an older review as news when a newer one is deleted — it keeps the time it was written', async () => {
    await createConnectionView(env.DB, { name: 'Everything', libraryId: null, mediaType: null, status: null, owned: null });
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const item = await book(asha, { rating: 8, review: 'Hers, from 2019.' });
    await env.DB.prepare("UPDATE reviews SET reviewed_at = '2019-06-01 10:00:00', updated_at = '2019-06-01 10:00:00'").run();
    const entries = () => rows<{ id: number; kind: string; at: string }>('SELECT id, kind, at FROM activity_log WHERE item_id = ?1 ORDER BY kind', item.id);

    const edit = (fields: Record<string, string>) =>
      as(ravi, `/items/${item.id}`, { body: { libraryId: String(item.libraryId), title: item.title, mediaType: 'book', status: 'not_started', ...fields } });
    await edit({ rating: '4', review: 'His, today.' });
    const his = await entries();
    expect(his.map((e) => e.kind)).toEqual(['rated', 'reviewed']);
    for (const e of his) expect(e.at.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10)); // genuinely new: today

    // he clears his: the household shows hers again, and her average — neither is news
    await edit({ rating: '', review: '' });
    expect(await summaryOf(item.id)).toMatchObject({ rating: 8, review: 'Hers, from 2019.' });
    const after = await entries();
    expect(after).toEqual([
      { id: expect.any(Number), kind: 'rated', at: '2019-06-01 10:00:00' },
      { id: expect.any(Number), kind: 'reviewed', at: '2019-06-01 10:00:00' },
    ]);
    // new ids all the same, so connections holding his review learn it's gone
    expect(after.map((e) => e.id).some((id) => his.some((h) => h.id === id))).toBe(false);

    // and deleting from the book's page does the same
    await edit({ rating: '5', review: 'His again.' });
    const [review] = (await rows<{ id: number }>('SELECT id FROM reviews WHERE user_id = ?1', ravi.id));
    await as(asha, `/items/${item.id}/reviews/${review!.id}/delete`, { body: {} });
    expect((await entries()).map((e) => e.at)).toEqual(['2019-06-01 10:00:00', '2019-06-01 10:00:00']);
  });

  it('record nothing new from an import: a Goodreads rating is dated by its read, or left out', async () => {
    await createConnectionView(env.DB, { name: 'Everything', libraryId: null, mediaType: null, status: null, owned: null });
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const item = await book(asha, { title: 'Kindred', creators: 'Octavia E. Butler', rating: 8, status: 'completed', completedOn: '2019-05-01' });
    const before = await rows<{ id: number }>("SELECT id FROM activity_log WHERE item_id = ?1 AND kind = 'rated'", item.id);
    await mergeImportItems(env.DB, [
      { item: { libraryId: item.libraryId, title: 'Kindred', creators: 'Octavia E. Butler', rating: 4, addedBy: ravi.id }, tags: [], goodreads: { shelf: 'completed', dateRead: '2018-02-01', dateStarted: null, readCount: null } },
    ]);
    expect(await summaryOf(item.id)).toMatchObject({ rating: 6 });
    const after = await rows<{ id: number; at: string }>("SELECT id, at FROM activity_log WHERE item_id = ?1 AND kind = 'rated'", item.id);
    expect(after[0]!.id).not.toBe(before[0]!.id); // the average moved, so the entry was replaced…
    expect(after[0]!.at.slice(0, 10)).toBe('2019-05-01'); // …dated by the book's last finish, not today
  });
});
