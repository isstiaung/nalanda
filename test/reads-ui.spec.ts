// Reading a book again, from its page (ARCH.md §16 #41): the Reading section and its routes, the re-reading
// marker wherever status shows, the edit form's rules, and progress on share pages for a re-read.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addProgress,
  closeRead,
  createItem,
  createLibrary,
  createShare,
  createUser,
  getItem,
  importItems,
  listProgress,
  startRead,
  updateSiteSettings,
} from '../src/db/queries';
import type { Item } from '../src/db/schema';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import { sessionTokenFor } from './session-helpers';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import { budgeted } from '../src/federation/budget';
import app from '../src/index';

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

// A household of one (§16 #43): every request is by the same member, whose reads and review the seeded books carry —
// what v1.2.1's household-level reads were, and must still behave as.
let userId = 0;
beforeEach(() => {
  userId = 0; // every test resets the database, so the user is made again
});
async function user() {
  if (!userId) {
    userId = (await createUser(env.DB, { username: `member${Date.now()}`, passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false })).id;
  }
  return userId;
}
const self = async () => ({ id: await user(), admin: false });

async function request(
  path: string,
  init: { body?: Record<string, string>; htmx?: boolean; origin?: string; anonymous?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin: init.origin ?? 'http://nalanda.test' };
  if (!init.anonymous) {
    const token = await sessionTokenFor(await user());
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
  return createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title: 'The Dispossessed', length: 300, details: '{}', addedBy: await user(), ...overrides });
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
    // the status above the section, swapped out of band: "Re-reading" stands in for Completed (§16 #64)
    expect(html).toMatch(/<span id="item-status"[^>]*hx-swap-oob="true"[^>]*><span class="pill rereading">Re-reading<\/span><\/span>/);
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: 'completed', rereading: true, completedOn: '2019-03-20' });
  });

  it('gives each form’s own action the primary button, Stop the secondary one, and Delete the danger one', async () => {
    const item = await finished();
    const done = await (await request(`/items/${item.id}`)).text();
    expect(done).toContain('<button type="submit">Read again</button>');
    expect(done).toContain('<button type="submit">Save</button>'); // correcting a read
    expect(done).toContain('<button type="submit">Add</button>'); // a past read
    expect(done).toMatch(/<button type="submit" class="btn-danger">\s*Delete this read/);

    await startRead(env.DB, item.id, '2026-09-01', await user());
    const open = await (await request(`/items/${item.id}`)).text();
    expect(open).toContain('<button type="submit">Record</button>');
    expect(open).toContain('<button type="submit">Finish</button>');
    expect(open).toMatch(/<button type="submit" class="btn">\s*Stop re-reading/);
  });

  it('lands back on the item page without htmx', async () => {
    const item = await finished();
    const res = await request(`/items/${item.id}/reads/start`, { body: {} });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/items/${item.id}`);
  });

  it('finishing the re-read moves completed_on to it and counts it', async () => {
    const item = await finished();
    await startRead(env.DB, item.id, '2026-09-01', await user());
    const html = await (await request(`/items/${item.id}/reads/${await openRead(item.id)}/finish`, { body: { date: '2026-09-20' }, htmx: true })).text();
    expect(html).toContain('Finished 2026-09-20 · read 2 times');
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: 'completed', completedOn: '2026-09-20', readCount: 2, rereading: false });
  });

  it('stopping a re-read keeps it as stopped, and the book as it was', async () => {
    const item = await finished();
    await startRead(env.DB, item.id, '2026-09-01', await user());
    await addProgress(env.DB, item.id, 80, await user());
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
    await startRead(env.DB, item.id, '2026-09-01', await user());
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

describe('after a saved change', () => {
  it('reloads the page when reading it back fails, rather than failing a change already made', async () => {
    const item = await finished();
    const token = await createSessionToken(env.SESSION_SECRET, await createUser(env.DB, { username: 'budget', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false }), Math.floor(Date.now() / 1000));
    // the session check, the book, and the write — then nothing left to read the section back with
    const budget = { left: 3 };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`http://nalanda.test/items/${item.id}/reads/start`, {
        method: 'POST',
        headers: { origin: 'http://nalanda.test', cookie: `${SESSION_COOKIE}=${token}`, 'HX-Request': 'true', 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      }),
      { ...env, DB: budgeted(env.DB, budget) },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(budget.left).toBe(0);
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe(`/items/${item.id}`);
    expect(await getItem(env.DB, item.id)).toMatchObject({ rereading: true }); // the change stands
  });
});

describe('the re-reading marker', () => {
  it('shows in place of the status on the item page, the shelf table and covers, and search results', async () => {
    const item = await finished();
    const quiet = await (await request(`/libraries/${item.libraryId}`)).text();
    expect(quiet).not.toContain('pill rereading'); // negative control: not before the re-read opens

    await startRead(env.DB, item.id, '2026-09-01', await user());
    expect(await (await request(`/items/${item.id}`)).text()).toContain('pill rereading');
    expect(quiet).not.toContain('×'); // one finish: no count
    expect(await (await request(`/libraries/${item.libraryId}`)).text()).toContain('pill rereading');
    expect(await (await request(`/libraries/${item.libraryId}?view=grid`)).text()).toContain('pill rereading');
    expect(await (await request('/search?q=Dispossessed')).text()).toContain('pill rereading');
  });

  it('counts the finishes on the shelf once there is more than one', async () => {
    const item = await finished();
    await startRead(env.DB, item.id, '2026-09-01', await user());
    await closeRead(env.DB, item.id, await openRead(item.id), 'completed', '2026-09-20', await self());
    const html = await (await request(`/libraries/${item.libraryId}`)).text();
    expect(html).toContain('2026-09-20');
    expect(html).toContain('×2');
  });

  it('lists the book under In progress while it is read again, and still under Completed (§16 #64)', async () => {
    const item = await finished();
    const before = await (await request(`/libraries/${item.libraryId}?status=in_progress`)).text();
    expect(before).not.toContain('The Dispossessed'); // negative control: finished, and not being read
    await startRead(env.DB, item.id, '2026-09-01', await user());
    const completed = await (await request(`/libraries/${item.libraryId}?status=completed`)).text();
    const inProgress = await (await request(`/libraries/${item.libraryId}?status=in_progress`)).text();
    expect(completed).toContain('The Dispossessed');
    expect(inProgress).toContain('The Dispossessed');
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
    await startRead(env.DB, item.id, '2026-09-01', await user());
    const res = await request(`/items/${item.id}`, { body: form(item, { status: 'in_progress', completedOn: '' }) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('being read again');
  });

  it('locks the reading fields of a book being read again, so its last finish can’t be rewritten from here', async () => {
    const item = await finished();
    await startRead(env.DB, item.id, '2026-09-01', await user());
    const html = await (await request(`/items/${item.id}/edit`)).text();
    expect(html).toMatch(/<select name="status" disabled/);
    expect(html).toMatch(/name="completedOn" value="2019-03-20" disabled/);

    // what the browser sends with the fields disabled: none of them — the rest of the edit saves
    const { status: _s, beganOn: _b, completedOn: _c, ...rest } = form(item, { title: 'Renamed' });
    expect((await request(`/items/${item.id}`, { body: rest })).status).toBe(302);
    // a form opened before the re-read began may send them, unchanged
    expect((await request(`/items/${item.id}`, { body: form(item, { title: 'Renamed again' }) })).status).toBe(302);
    expect(await getItem(env.DB, item.id)).toMatchObject({ title: 'Renamed again', status: 'completed', completedOn: '2019-03-20', rereading: true });

    // but not changed: "Abandoned" would turn the only finish into a stop, a new date would overwrite it
    for (const over of [{ status: 'abandoned' }, { completedOn: '2026-09-25' }] as Record<string, string>[]) {
      const res = await request(`/items/${item.id}`, { body: form(item, { ...over, title: 'Nope' }) });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('being read again');
    }
    expect(await rows('SELECT status, began_on, ended_on FROM reads WHERE item_id = ?1 ORDER BY id', item.id)).toEqual([
      { status: 'completed', began_on: '2019-03-01', ended_on: '2019-03-20' },
      { status: 'in_progress', began_on: '2026-09-01', ended_on: null },
    ]);
  });

  it('gives a refused form back as it was sent: tags and cover included', async () => {
    const item = await finished();
    const res = await request(`/items/${item.id}`, {
      body: form(item, { completedOn: '2999-01-01', tags: 'favourites, re-read', coverUrl: 'https://covers.example/x.jpg' }),
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('value="favourites, re-read"');
    expect(html).toContain('value="https://covers.example/x.jpg"');
  });

  it('won’t reopen a finish as "in progress" — the old way of saying "reading it again" — and says to use Read again', async () => {
    const item = await finished();
    const res = await request(`/items/${item.id}`, { body: form(item, { status: 'in_progress', completedOn: '', title: 'Renamed', tags: 'kept' }) });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('use Read again on its page');
    // the refused form comes back as it was sent
    expect(html).toContain('value="Renamed"');
    expect(html).toContain('value="kept"');
    expect(html).toMatch(/<option value="in_progress" selected/);
    expect(await rows('SELECT status, began_on, ended_on FROM reads WHERE item_id = ?1', item.id)).toEqual([
      { status: 'completed', began_on: '2019-03-01', ended_on: '2019-03-20' },
    ]);
    expect(await getItem(env.DB, item.id)).toMatchObject({ title: 'The Dispossessed', status: 'completed', completedOn: '2019-03-20', readCount: 1 });
  });

  it('says why it won’t open a second read on a record being played again, instead of saving nothing', async () => {
    // Records and games have no Reading section, but a Nalanda re-import can give one a finish and an open read. The
    // finished-book guard covers books only, and the database refuses a second open read on its own, so without this
    // check the form would redirect as if saved and silently drop the status change.
    const shelf = await createLibrary(env.DB, 'Records');
    await importItems(env.DB, [
      {
        item: { libraryId: shelf.id, mediaType: 'vinyl', title: 'Kind of Blue', details: '{}', addedBy: await user() },
        tags: [],
        reads: [
          { status: 'completed', beganOn: '2020-01-01', endedOn: '2020-01-10' },
          { status: 'in_progress', beganOn: '2026-09-01', endedOn: null },
        ],
      },
    ]);
    const record = (await getItem(env.DB, (await rows<{ id: number }>('SELECT id FROM items'))[0]!.id))!;
    expect(record).toMatchObject({ mediaType: 'vinyl', rereading: true, readCount: 1 });
    const before = await rows('SELECT status, began_on, ended_on FROM reads WHERE item_id = ?1 ORDER BY id', record.id);

    const res = await request(`/items/${record.id}`, {
      body: { ...form(record, { status: 'in_progress', completedOn: '' }), mediaType: 'vinyl' },
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('It already has a read in progress');
    expect(await rows('SELECT status, began_on, ended_on FROM reads WHERE item_id = ?1 ORDER BY id', record.id)).toEqual(before);
  });

  it('won’t relabel the latest finish a stop, and says where stopping is done', async () => {
    const item = await finished();
    await request(`/items/${item.id}/reads`, { body: { status: 'completed', beganOn: '2010-01-01', endedOn: '2010-02-01' } });
    const res = await request(`/items/${item.id}`, { body: form(item, { status: 'abandoned' }) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('To record a read you stopped, use its page');
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: 'completed', readCount: 2 });
  });

  it('still lets the form finish or stop a first read, correct a finish’s dates, and stop a record — the refusal is only for finished books', async () => {
    const reading = await book({ status: 'in_progress', beganOn: '2026-09-01' });
    expect((await request(`/items/${reading.id}`, { body: form(reading, { status: 'abandoned', completedOn: '2026-09-10' }) })).status).toBe(302);
    expect(await getItem(env.DB, reading.id)).toMatchObject({ status: 'abandoned', completedOn: '2026-09-10' });

    const done = await finished();
    expect((await request(`/items/${done.id}`, { body: form(done, { completedOn: '2019-03-22' }) })).status).toBe(302);
    expect(await getItem(env.DB, done.id)).toMatchObject({ status: 'completed', completedOn: '2019-03-22', readCount: 1 });

    const record = await createItem(env.DB, { libraryId: (await createLibrary(env.DB, 'Records')).id, mediaType: 'vinyl', title: 'Blue', status: 'completed', completedOn: '2020-01-01', details: '{}', addedBy: await user() });
    const body = { libraryId: String(record.libraryId), title: 'Blue', mediaType: 'vinyl', status: 'abandoned', beganOn: '', completedOn: '2020-01-01' };
    expect((await request(`/items/${record.id}`, { body })).status).toBe(302); // no Reading section: the form is how
    expect(await getItem(env.DB, record.id)).toMatchObject({ status: 'abandoned' });
  });

  it('offers a finished book only Completed, and a book being read the rest', async () => {
    const done = await finished();
    const doneForm = await (await request(`/items/${done.id}/edit`)).text();
    expect(doneForm).toContain('value="completed"');
    for (const hidden of ['in_progress', 'abandoned', 'not_started']) expect(doneForm).not.toContain(`value="${hidden}"`);
    expect(doneForm).toContain('Finished before');

    const reading = await book({ status: 'in_progress', beganOn: '2026-09-01' });
    const readingForm = await (await request(`/items/${reading.id}/edit`)).text();
    for (const shown of ['in_progress', 'completed', 'abandoned']) expect(readingForm).toContain(`value="${shown}"`);
  });

  it('offers "Not started" only to a book with no reads', async () => {
    const fresh = await book();
    const read = await finished();
    expect(await (await request(`/items/${fresh.id}/edit`)).text()).toContain('value="not_started"');
    expect(await (await request(`/items/${read.id}/edit`)).text()).not.toContain('value="not_started"');
  });

  it('lets a record or board game be made not started again, clearing its read — a book has its page for that', async () => {
    const shelf = await createLibrary(env.DB, 'Records');
    const record = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Kind of Blue', status: 'completed', completedOn: '2020-01-01', details: '{}', addedBy: await user() });
    // the form picks no reading status for a record (it takes plays), carrying its own back as it came; the route still clears one
    const form = await (await request(`/items/${record.id}/edit`)).text();
    expect(form).not.toContain('<select name="status"');
    expect(form).toContain('<input type="hidden" name="status" value="completed"/>');
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

    await startRead(env.DB, item.id, '2026-09-01', await user());
    await addProgress(env.DB, item.id, 150, await user());
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
