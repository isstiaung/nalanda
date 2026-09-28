// Reading a book again, from its page (ARCH.md §16 #41): the Reading section and its routes, the re-reading
// marker wherever status shows, the edit form's rules, and progress on share pages for a re-read.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  addProgress,
  closeRead,
  createItem,
  createLibrary,
  createShare,
  createUser,
  getItem,
  listProgress,
  startRead,
  updateSiteSettings,
} from '../src/db/queries';
import type { Item } from '../src/db/schema';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

let userId = 0;
async function user() {
  if (!userId) {
    userId = (await createUser(env.DB, { username: `member${Date.now()}`, passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false })).id;
  }
  return userId;
}

async function request(
  path: string,
  init: { body?: Record<string, string>; htmx?: boolean; origin?: string; anonymous?: boolean } = {},
): Promise<Response> {
  userId = 0; // every test resets the database, so the user is made again
  const headers: Record<string, string> = { origin: init.origin ?? 'http://nalanda.test' };
  if (!init.anonymous) {
    const token = await createSessionToken(env.SESSION_SECRET, await user(), Math.floor(Date.now() / 1000));
    headers.cookie = `${SESSION_COOKIE}=${token}`;
  }
  if (init.htmx) headers['HX-Request'] = 'true';
  if (init.body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, {
      method: init.body ? 'POST' : 'GET',
      headers,
      body: init.body ? new URLSearchParams(init.body).toString() : undefined,
      redirect: 'manual',
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function book(overrides: Partial<Item> = {}) {
  const shelf = await createLibrary(env.DB, 'Reading shelf');
  return createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title: 'The Dispossessed', length: 300, details: '{}', ...overrides });
}

const finished = () => book({ status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20' });
const openRead = async (itemId: number) =>
  (await rows<{ id: number }>("SELECT id FROM reads WHERE item_id = ?1 AND status = 'in_progress'", itemId))[0]!.id;

describe('the Reading section', () => {
  it('offers "Read again" on a finished book, and no page field until a read is open', async () => {
    const item = await finished();
    const html = await (await request(`/items/${item.id}`)).text();
    expect(html).toContain('Finished 2019-03-20');
    expect(html).toContain('Read again');
    expect(html).not.toContain('name="page"');
    expect(html).not.toContain('Re-reading');
  });

  it('offers "Start reading" and the page field on a book never started', async () => {
    const item = await book();
    const html = await (await request(`/items/${item.id}`)).text();
    expect(html).toContain('Start reading');
    expect(html).toContain('name="page"');
    expect(html).toContain('Not started.');
  });

  it('"Read again" opens a re-read: the book stays Completed, marked re-reading, and the page field appears', async () => {
    const item = await finished();
    const res = await request(`/items/${item.id}/reads/start`, { body: {}, htmx: true });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Re-reading, since');
    expect(html).toContain('name="page"');
    expect(html).toContain('Stop re-reading');
    // the status above the section, swapped out of band
    expect(html).toMatch(/<span id="item-status"[^>]*hx-swap-oob="true"[^>]*>.*Completed.*Re-reading/s);
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: 'completed', rereading: true, completedOn: '2019-03-20' });
  });

  it('lands back on the item page without htmx', async () => {
    const item = await finished();
    const res = await request(`/items/${item.id}/reads/start`, { body: {} });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/items/${item.id}`);
  });

  it('finishing the re-read moves completed_on to it and counts it', async () => {
    const item = await finished();
    await startRead(env.DB, item.id, '2026-09-01');
    const html = await (await request(`/items/${item.id}/reads/${await openRead(item.id)}/finish`, { body: { date: '2026-09-20' }, htmx: true })).text();
    expect(html).toContain('Finished 2026-09-20 · read 2 times');
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: 'completed', completedOn: '2026-09-20', readCount: 2, rereading: false });
  });

  it('stopping a re-read keeps it as stopped, and the book as it was', async () => {
    const item = await finished();
    await startRead(env.DB, item.id, '2026-09-01');
    await addProgress(env.DB, item.id, 80, null);
    const html = await (await request(`/items/${item.id}/reads/${await openRead(item.id)}/stop`, { body: {}, htmx: true })).text();
    expect(html).toContain('stopped at p. 80');
    expect(html).toContain('Read again');
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: 'completed', completedOn: '2019-03-20', readCount: 1, rereading: false });
  });

  it('refuses a page on a finished book with no open read, and says why', async () => {
    const item = await finished();
    const html = await (await request(`/items/${item.id}/progress`, { body: { page: '40' }, htmx: true })).text();
    expect(html).toContain('isn’t being read now');
    expect(await listProgress(env.DB, item.id)).toEqual([]);
  });

  it('adds, corrects and deletes a past read', async () => {
    const item = await finished();
    await request(`/items/${item.id}/reads`, { body: { status: 'completed', beganOn: '2010-05-01', endedOn: '2010-06-01' }, htmx: true });
    const past = (await rows<{ id: number }>("SELECT id FROM reads WHERE began_on = '2010-05-01'"))[0]!.id;
    expect(await getItem(env.DB, item.id)).toMatchObject({ readCount: 2, completedOn: '2019-03-20' }); // older: not the last finish

    const refused = await (await request(`/items/${item.id}/reads/${past}`, { body: { status: 'completed', beganOn: '2010-06-02', endedOn: '2010-06-01' }, htmx: true })).text();
    expect(refused).toContain('can’t end before it began');

    await request(`/items/${item.id}/reads/${past}`, { body: { status: 'abandoned', beganOn: '2010-05-01', endedOn: '2010-05-20' }, htmx: true });
    expect(await getItem(env.DB, item.id)).toMatchObject({ readCount: 1 });

    const html = await (await request(`/items/${item.id}/reads/${past}/delete`, { body: {}, htmx: true })).text();
    expect(html).not.toContain('2010-05-01');
    expect(await rows('SELECT * FROM reads WHERE item_id = ?1', item.id)).toHaveLength(1);
  });

  it('won’t reopen an old read while another is open, and says so', async () => {
    const item = await finished();
    await startRead(env.DB, item.id, '2026-09-01');
    const first = (await rows<{ id: number }>("SELECT id FROM reads WHERE item_id = ?1 AND status = 'completed'", item.id))[0]!.id;
    const html = await (await request(`/items/${item.id}/reads/${first}`, { body: { status: 'in_progress', beganOn: '2019-03-01' }, htmx: true })).text();
    expect(html).toContain('Another read is open');
    expect(await rows("SELECT * FROM reads WHERE item_id = ?1 AND status = 'in_progress'", item.id)).toHaveLength(1);
  });

  it('keeps reads to books, and to people signed in from this site', async () => {
    const record = await createItem(env.DB, { libraryId: (await createLibrary(env.DB, 'Records')).id, mediaType: 'vinyl', title: 'Kind of Blue', details: '{}' });
    expect((await request(`/items/${record.id}/reads/start`, { body: {} })).status).toBe(404);

    const item = await finished();
    expect((await request(`/items/${item.id}/reads/start`, { body: {}, origin: 'https://evil.example' })).status).toBe(403);
    expect((await request(`/items/${item.id}/reads/start`, { body: {}, anonymous: true })).status).toBe(302); // to the login page
    expect(await rows('SELECT * FROM reads WHERE item_id = ?1', item.id)).toHaveLength(1);
  });
});

describe('the re-reading marker', () => {
  it('shows beside the status on the item page, the shelf table and covers, and search results', async () => {
    const item = await finished();
    const quiet = await (await request(`/libraries/${item.libraryId}`)).text();
    expect(quiet).not.toContain('pill rereading'); // negative control: not before the re-read opens

    await startRead(env.DB, item.id, '2026-09-01');
    expect(await (await request(`/items/${item.id}`)).text()).toContain('pill rereading');
    expect(quiet).not.toContain('×'); // one finish: no count
    expect(await (await request(`/libraries/${item.libraryId}`)).text()).toContain('pill rereading');
    expect(await (await request(`/libraries/${item.libraryId}?view=grid`)).text()).toContain('pill rereading');
    expect(await (await request('/search?q=Dispossessed')).text()).toContain('pill rereading');
  });

  it('counts the finishes on the shelf once there is more than one', async () => {
    const item = await finished();
    await startRead(env.DB, item.id, '2026-09-01');
    await closeRead(env.DB, item.id, await openRead(item.id), 'completed', '2026-09-20');
    const html = await (await request(`/libraries/${item.libraryId}`)).text();
    expect(html).toContain('2026-09-20');
    expect(html).toContain('×2');
  });

  it('leaves the book where status filters put it', async () => {
    const item = await finished();
    await startRead(env.DB, item.id, '2026-09-01');
    const completed = await (await request(`/libraries/${item.libraryId}?status=completed`)).text();
    const inProgress = await (await request(`/libraries/${item.libraryId}?status=in_progress`)).text();
    expect(completed).toContain('The Dispossessed');
    expect(inProgress).not.toContain('The Dispossessed');
  });
});

describe('the edit form', () => {
  const form = (item: Item, over: Record<string, string>) => ({
    libraryId: String(item.libraryId),
    title: item.title,
    mediaType: 'book',
    status: item.status,
    beganOn: item.beganOn ?? '',
    completedOn: item.completedOn ?? '',
    ...over,
  });

  it('edits the last finished read, never adding one', async () => {
    const item = await finished();
    const res = await request(`/items/${item.id}`, { body: form(item, { completedOn: '2019-03-21' }) });
    expect(res.status).toBe(302);
    expect(await rows('SELECT status, ended_on FROM reads WHERE item_id = ?1', item.id)).toEqual([{ status: 'completed', ended_on: '2019-03-21' }]);
    expect(await getItem(env.DB, item.id)).toMatchObject({ completedOn: '2019-03-21' });
  });

  it('refuses what a read can’t be, saves nothing, and says why', async () => {
    const item = await finished();
    const cases: Array<[Record<string, string>, string]> = [
      [{ status: 'not_started', beganOn: '', completedOn: '' }, 'This book has reads'],
      [{ status: 'in_progress' }, 'no completion date'],
      [{ completedOn: '2019-02-01' }, 'can’t end before it began'],
      [{ completedOn: '2999-01-01' }, 'future'],
    ];
    for (const [over, message] of cases) {
      const res = await request(`/items/${item.id}`, { body: form(item, { ...over, title: 'Renamed' }) });
      expect(res.status, message).toBe(400);
      expect(await res.text()).toContain(message);
    }
    expect(await getItem(env.DB, item.id)).toMatchObject({ title: 'The Dispossessed', status: 'completed', completedOn: '2019-03-20' });
  });

  it('won’t reopen the last finish while a re-read is open', async () => {
    const item = await finished();
    await startRead(env.DB, item.id, '2026-09-01');
    const res = await request(`/items/${item.id}`, { body: form(item, { status: 'in_progress', completedOn: '' }) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('being read again');
  });

  it('offers "Not started" only to a book with no reads', async () => {
    const fresh = await book();
    const read = await finished();
    expect(await (await request(`/items/${fresh.id}/edit`)).text()).toContain('value="not_started"');
    expect(await (await request(`/items/${read.id}/edit`)).text()).not.toContain('value="not_started"');
  });

  it('lets a record or board game be made not started again, clearing its read — a book has its page for that', async () => {
    const shelf = await createLibrary(env.DB, 'Records');
    const record = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Kind of Blue', status: 'completed', completedOn: '2020-01-01', details: '{}' });
    expect(await (await request(`/items/${record.id}/edit`)).text()).toContain('value="not_started"');
    const res = await request(`/items/${record.id}`, {
      body: { libraryId: String(shelf.id), title: 'Kind of Blue', mediaType: 'vinyl', status: 'not_started', beganOn: '', completedOn: '' },
    });
    expect(res.status).toBe(302);
    expect(await rows('SELECT * FROM reads WHERE item_id = ?1', record.id)).toEqual([]);
    expect(await getItem(env.DB, record.id)).toMatchObject({ status: 'not_started', completedOn: null, readCount: 0 });
  });

  it('refuses reading dates on a new item marked not started', async () => {
    const shelf = await createLibrary(env.DB, 'Shelf');
    const res = await request('/items', { body: { libraryId: String(shelf.id), title: 'New', mediaType: 'book', status: 'not_started', completedOn: '2020-01-01' } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('A book not started has no reading dates');
    expect(await rows('SELECT * FROM items')).toEqual([]);
  });
});

describe('progress on share pages for a re-read', () => {
  it('is what the setting means by "reading now": shown for an open re-read, and only when on', async () => {
    const item = await finished();
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: item.libraryId });
    await updateSiteSettings(env.DB, { progressOnShares: true });
    // writes here go straight to the database, past the mutation hook that clears the share-page cache
    const page = () => {
      clearSharePageCache();
      return request(`/share/${share.token}/items/${item.id}`, { anonymous: true }).then((r) => r.text());
    };

    expect(await page()).not.toContain('progress-track'); // finished, not being read: nothing to show

    await startRead(env.DB, item.id, '2026-09-01');
    await addProgress(env.DB, item.id, 150, null);
    expect(await page()).toContain('p. 150');

    await updateSiteSettings(env.DB, { progressOnShares: false });
    expect(await page()).not.toContain('p. 150');
  });

  it('keeps the key off the public item otherwise', async () => {
    const item = await finished();
    expect(toPublicItem({ ...item, progressPage: 90 }, { progress: true })).not.toHaveProperty('progress');
    expect(toPublicItem({ ...item, progressPage: 90, rereading: true }, { progress: true })).toHaveProperty('progress');
    expect(toPublicItem({ ...item, progressPage: 90, rereading: true })).not.toHaveProperty('progress');
  });
});
