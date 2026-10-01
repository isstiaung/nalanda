// The trash (ARCH.md §16 #74): a deleted item leaves everything as a delete always did, and one row keeps what it
// was — built by SQLite in the delete's own batch — for 30 days. Restoring runs the snapshot back through the
// import's insert, under a new id, with everything that hung off it.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  addPastRead,
  addProgress,
  bulkDelete,
  createLibrary,
  createShare,
  deleteItem,
  deleteUser,
  getItem,
  getTrash,
  listMembersWithKeys,
  listTrash,
  logPlay,
  memberKeys,
  purgeTrash,
  restoreFromTrash,
  setItemTags,
  setWant,
  startRead,
  trashItems,
  updateItemWithTags,
  type TrashPayload,
} from '../src/db/queries';
import { newShareToken } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import { as, book, html, member, rows, type Member } from './member-helpers';

async function furnished() {
  const asha = await member('asha', 'admin');
  const ravi = await member('ravi');
  const shelf = await createLibrary(env.DB, 'Fiction');
  await env.COVERS.put('cover-piranesi', 'jpegbytes', { httpMetadata: { contentType: 'image/jpeg' } });
  const b = await book(asha, {
    libraryId: shelf.id,
    title: 'Piranesi',
    creators: 'Susanna Clarke',
    isbn13: '9781526622426',
    publisher: 'Bloomsbury',
    published: '2020',
    description: 'A house with infinite halls.',
    length: 245,
    notes: 'A gift from Priya',
    location: 'Study, 2nd shelf',
    copies: 2,
    coverKey: 'cover-piranesi',
    details: JSON.stringify({ openlibrary_id: 'OL123W' }),
    purchasePrice: 49900,
    purchaseCurrency: 'INR',
  });
  // tags and the series as asha, with her review; ravi's rating through the same form as him
  await updateItemWithTags(env.DB, b.id, {}, ['fantasy', 'favourites'], undefined, asha.id, { rating: 9, review: 'Luminous.' }, { name: 'Standalones', number: 2.5, total: 5 });
  await updateItemWithTags(env.DB, b.id, {}, ['fantasy', 'favourites'], undefined, ravi.id, { rating: 7, review: null });
  await addPastRead(env.DB, b.id, { status: 'completed', beganOn: '2024-01-01', endedOn: '2024-01-20' }, asha.id);
  await startRead(env.DB, b.id, '2026-09-01', ravi.id);
  await addProgress(env.DB, b.id, 120, ravi.id);
  await addProgress(env.DB, b.id, 180, ravi.id);
  await env.DB.prepare("INSERT INTO loans (item_id, borrower, loaned_on, due_on, contact, note) VALUES (?1, 'Priya', '2026-03-01', '2026-04-01', 'priya@example.com', 'Birthday')").bind(b.id).run();
  await setWant(env.DB, b.id, ravi.id, true);
  await as(asha, `/items/${b.id}/links`, { body: { label: 'Bookshop', url: 'https://bookshop.example/piranesi' } });
  return { asha, ravi, shelf, b };
}

const payloadOf = async (trashId: number) => JSON.parse((await getTrash(env.DB, trashId))!.payload) as TrashPayload;
const deleter = (m: Member) => ({ id: m.id, sessionKey: m.sessionKey });
const members = async () => memberKeys(await listMembersWithKeys(env.DB));
const restored = async (trashId: number) => {
  const outcome = await restoreFromTrash(env.DB, trashId, await members());
  if ('refused' in outcome) throw new Error(`refused: ${outcome.refused}`);
  return outcome.id;
};

describe('deleting an item', () => {
  it('removes it from every surface as before, keeps its cover, and leaves one trash row holding what it was', async () => {
    const { asha, ravi, shelf, b } = await furnished();
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Shelf', libraryId: shelf.id });
    clearSharePageCache();

    const res = await as(asha, `/items/${b.id}/delete`, { body: {} });
    expect(res.status).toBe(302);
    expect(await getItem(env.DB, b.id)).toBeNull();
    expect(await rows('SELECT 1 FROM reads WHERE item_id = ?1', b.id)).toEqual([]);
    expect(await rows('SELECT 1 FROM reading_progress WHERE item_id = ?1', b.id)).toEqual([]);
    expect(await html(asha, `/libraries/${shelf.id}`)).not.toContain('Piranesi');
    expect(await html(asha, '/search?q=piranesi')).not.toContain('Piranesi');
    expect((await as(null, `/share/${token}/items/${b.id}`)).status).toBe(404);
    expect(await env.COVERS.get('cover-piranesi')).not.toBeNull(); // kept until the row is purged

    const list = await listTrash(env.DB);
    expect(list).toEqual([
      {
        id: expect.any(Number),
        itemId: b.id,
        libraryId: shelf.id,
        libraryName: 'Fiction',
        mediaType: 'book',
        title: 'Piranesi',
        creators: 'Susanna Clarke',
        coverKey: 'cover-piranesi',
        deletedAt: expect.any(String),
        deletedBy: asha.id,
        deletedByKey: asha.sessionKey,
      },
    ]);
    const p = await payloadOf(list[0]!.id);
    // the item's every column but its id, as the schema names them — a column added later must be here the day it exists
    expect(Object.keys(p.item).sort()).toEqual(Object.keys(getTableColumns(s.items)).filter((k) => k !== 'id').sort());
    expect(p.item).toMatchObject({ title: 'Piranesi', notes: 'A gift from Priya', location: 'Study, 2nd shelf', copies: 2, purchasePrice: 49900, seriesNumber: 2.5, coverKey: 'cover-piranesi' });
    expect(p.tags).toEqual(['fantasy', 'favourites']);
    expect(p.series).toEqual({ name: 'Standalones', number: 2.5, total: 5 });
    expect(p.reads).toEqual([
      { status: 'completed', beganOn: '2024-01-01', endedOn: '2024-01-20', readerId: asha.id },
      { status: 'in_progress', beganOn: '2026-09-01', endedOn: null, readerId: ravi.id },
    ]);
    expect(p.reviews.map((r) => ({ userId: r.userId, rating: r.rating, review: r.review }))).toEqual([
      { userId: asha.id, rating: 9, review: 'Luminous.' },
      { userId: ravi.id, rating: 7, review: null },
    ]);
    expect(p.reviews[0]!.reviewedAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(p.loans).toEqual([{ borrower: 'Priya', loanedOn: '2026-03-01', dueOn: '2026-04-01', returnedOn: null, contact: 'priya@example.com', note: 'Birthday', edition: null }]);
    expect(p.plays).toEqual([]);
    expect(p.wants).toEqual([{ userId: ravi.id, at: expect.any(String) }]);
    expect(p.links).toEqual([{ label: 'Bookshop', url: 'https://bookshop.example/piranesi' }]);
    expect(p.people).toEqual({ [asha.id]: asha.sessionKey, [ravi.id]: ravi.sessionKey }); // who each id was, then
    expect(p.progress).toEqual([
      { page: 120, at: expect.any(String), addedBy: ravi.id, read: { status: 'in_progress', beganOn: '2026-09-01', endedOn: null, readerId: ravi.id } },
      { page: 180, at: expect.any(String), addedBy: ravi.id, read: { status: 'in_progress', beganOn: '2026-09-01', endedOn: null, readerId: ravi.id } },
    ]);
  });

  it('in bulk, likewise, by an admin, with the series pruned as before', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const one = await book(asha, { libraryId: shelf.id, title: 'One', coverKey: 'c1' });
    const two = await book(asha, { libraryId: shelf.id, title: 'Two' });
    await updateItemWithTags(env.DB, one.id, {}, [], undefined, asha.id, undefined, { name: 'Lonely', number: 1 });
    const result = await bulkDelete(env.DB, [one.id, two.id, 999_999], deleter(asha));
    expect(result).toEqual({ found: 2, changed: 2, same: 0, skipped: 0, covers: [] });
    expect((await listTrash(env.DB)).map((r) => r.title)).toEqual(['Two', 'One']);
    expect(await rows("SELECT 1 FROM series WHERE name = 'Lonely'")).toEqual([]);
  });

  it('trashes nothing that is not there, and leaves no row for it', async () => {
    expect(await trashItems(env.DB, [42], null)).toEqual({ trashed: 0, expired: [] });
    expect(await listTrash(env.DB)).toEqual([]);
  });
});

describe('restoring', () => {
  it('brings the item back under a new id with everything it had, and the trash row goes', async () => {
    const { asha, ravi, shelf, b } = await furnished();
    await deleteItem(env.DB, b.id, deleter(asha));
    const [row] = await listTrash(env.DB);
    const newId = await restored(row!.id); // a new id — which may happen to be the old one again, as SQLite hands out max(id)+1
    expect(await listTrash(env.DB)).toEqual([]);

    const item = (await getItem(env.DB, newId))!;
    expect(item).toMatchObject({
      libraryId: shelf.id,
      title: 'Piranesi',
      creators: 'Susanna Clarke',
      isbn13: '9781526622426',
      notes: 'A gift from Priya',
      location: 'Study, 2nd shelf',
      copies: 2,
      coverKey: 'cover-piranesi',
      purchasePrice: 49900,
      purchaseCurrency: 'INR',
      seriesNumber: 2.5,
      addedBy: asha.id,
      status: 'completed',
      rereading: true, // asha finished it, ravi is reading it again
      readCount: 1,
      rating: 8, // the household average of 9 and 7
      review: 'Luminous.',
    });
    expect(item.addedAt).toBe(b.addedAt);
    expect((await rows<{ name: string }>('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ?1 ORDER BY t.name', newId)).map((r) => r.name)).toEqual(['fantasy', 'favourites']);
    expect(await rows('SELECT s.name, s.total FROM series s WHERE s.id = ?1', item.seriesId)).toEqual([{ name: 'Standalones', total: 5 }]);
    expect(await rows('SELECT status, began_on AS beganOn, ended_on AS endedOn, reader_id AS readerId FROM reads WHERE item_id = ?1 ORDER BY id', newId)).toEqual([
      { status: 'completed', beganOn: '2024-01-01', endedOn: '2024-01-20', readerId: asha.id },
      { status: 'in_progress', beganOn: '2026-09-01', endedOn: null, readerId: ravi.id },
    ]);
    expect(await rows('SELECT user_id AS userId, rating, review FROM reviews WHERE item_id = ?1 ORDER BY id', newId)).toEqual([
      { userId: asha.id, rating: 9, review: 'Luminous.' },
      { userId: ravi.id, rating: 7, review: null },
    ]);
    // the pages, each back on ravi's open read
    const pages = await rows<{ page: number; addedBy: number; reader: number; status: string }>(
      'SELECT p.page, p.added_by AS addedBy, r.reader_id AS reader, r.status FROM reading_progress p JOIN reads r ON r.id = p.read_id WHERE p.item_id = ?1 ORDER BY p.id',
      newId,
    );
    expect(pages).toEqual([
      { page: 120, addedBy: ravi.id, reader: ravi.id, status: 'in_progress' },
      { page: 180, addedBy: ravi.id, reader: ravi.id, status: 'in_progress' },
    ]);
    expect(item.progressPage).toBe(180);
    expect(await rows('SELECT borrower, loaned_on AS loanedOn, due_on AS dueOn, returned_on AS returnedOn, contact, note FROM loans WHERE item_id = ?1', newId)).toEqual([
      { borrower: 'Priya', loanedOn: '2026-03-01', dueOn: '2026-04-01', returnedOn: null, contact: 'priya@example.com', note: 'Birthday' },
    ]);
    expect(await rows('SELECT user_id AS userId FROM wants WHERE item_id = ?1', newId)).toEqual([{ userId: ravi.id }]);
    expect(await rows('SELECT label, url FROM purchase_links WHERE item_id = ?1', newId)).toEqual([{ label: 'Bookshop', url: 'https://bookshop.example/piranesi' }]);
    // back on its shelf, with its cover, and in search
    expect(await html(asha, `/libraries/${shelf.id}`)).toContain('Piranesi');
    expect(await html(asha, `/items/${newId}`)).toContain('src="/covers/cover-piranesi"');
    expect(await html(asha, '/search?q=piranesi')).toContain('Piranesi');
    // and a second restore of the same row is nothing
    expect(await restoreFromTrash(env.DB, row!.id, await members())).toEqual({ refused: 'gone' });
  });

  it('brings a game back with its plays, and a record with its grades', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Things');
    const { createItem } = await import('../src/db/queries');
    const game = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'boardgame', title: 'Azul', details: JSON.stringify({ bgg_id: 230802 }) });
    await logPlay(env.DB, game.id, '2026-05-05', asha.id);
    await env.DB.prepare("INSERT INTO plays (item_id, played_on, logged_by) VALUES (?1, '2026-06-06', NULL)").bind(game.id).run(); // a member removed since
    const record = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Kind of Blue', details: '{}', mediaCondition: 'VG+', sleeveCondition: 'VG' });
    await bulkDelete(env.DB, [game.id, record.id], deleter(asha));
    for (const row of await listTrash(env.DB)) await restored(row.id);
    const [g] = await rows<{ id: number }>("SELECT id FROM items WHERE title = 'Azul'");
    expect(await rows('SELECT played_on AS playedOn, logged_by AS loggedBy FROM plays WHERE item_id = ?1 ORDER BY id', g!.id)).toEqual([
      { playedOn: '2026-05-05', loggedBy: asha.id },
      { playedOn: '2026-06-06', loggedBy: null },
    ]);
    expect(await rows("SELECT media_condition AS media, sleeve_condition AS sleeve, details FROM items WHERE title = 'Kind of Blue'")).toEqual([{ media: 'VG+', sleeve: 'VG', details: '{}' }]);
    expect(await rows("SELECT details FROM items WHERE title = 'Azul'")).toEqual([{ details: JSON.stringify({ bgg_id: 230802 }) }]);
  });

  it('makes a member removed since nobody on what was theirs, and drops their want', async () => {
    const { asha, ravi, b } = await furnished();
    await deleteItem(env.DB, b.id, deleter(asha));
    await deleteUser(env.DB, ravi.id);
    const [row] = await listTrash(env.DB);
    const newId = await restored(row!.id);
    expect(await rows('SELECT reader_id AS readerId FROM reads WHERE item_id = ?1 ORDER BY id', newId)).toEqual([{ readerId: asha.id }, { readerId: null }]);
    expect(await rows('SELECT user_id AS userId FROM reviews WHERE item_id = ?1 ORDER BY id', newId)).toEqual([{ userId: asha.id }, { userId: null }]);
    expect(await rows('SELECT added_by AS addedBy FROM reading_progress WHERE item_id = ?1', newId)).toEqual([{ addedBy: null }, { addedBy: null }]);
    expect(await rows('SELECT 1 FROM wants WHERE item_id = ?1', newId)).toEqual([]);
  });

  it('gives a member given a removed member’s id since nothing of theirs — reads, review, pages, want (§16 #56)', async () => {
    const { asha, ravi, b } = await furnished();
    await deleteItem(env.DB, b.id, deleter(ravi)); // ravi deleted it, too
    await deleteUser(env.DB, ravi.id);
    const newcomer = await member('newcomer'); // ids are reused: the newest member's id is free again
    expect(newcomer.id).toBe(ravi.id);
    expect(newcomer.sessionKey).not.toBe(ravi.sessionKey);
    // the page names nobody as the deleter
    const text = await html(asha, '/trash');
    expect(text).toContain('Piranesi');
    expect(text).not.toContain('by newcomer');
    expect(text).not.toContain('by ravi');
    const [row] = await listTrash(env.DB);
    const newId = await restored(row!.id);
    expect(await rows('SELECT reader_id AS readerId FROM reads WHERE item_id = ?1 ORDER BY id', newId)).toEqual([{ readerId: asha.id }, { readerId: null }]);
    expect(await rows('SELECT user_id AS userId FROM reviews WHERE item_id = ?1 ORDER BY id', newId)).toEqual([{ userId: asha.id }, { userId: null }]);
    expect(await rows('SELECT added_by AS addedBy FROM reading_progress WHERE item_id = ?1', newId)).toEqual([{ addedBy: null }, { addedBy: null }]);
    expect(await rows('SELECT 1 FROM wants WHERE item_id = ?1', newId)).toEqual([]);
    // on the page, the old member's read and rating are a former member's, and the newcomer has none
    const page = await html(newcomer, `/items/${newId}`);
    expect(page).toContain('Former member');
    expect(page).not.toContain('<span class="reviewer">newcomer</span>');
    expect(page).toMatch(/newcomer<\/span><\/p><p class="reading-summary muted">Not started\./);
  });

  it('goes to the shelf it was on while that shelf is still so named, else to a shelf of that name, else is refused and stays', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Doomed shelf');
    const b = await book(asha, { libraryId: shelf.id, title: 'Orphan' });
    await deleteItem(env.DB, b.id, deleter(asha));
    // the shelf gone, and its id given to another shelf: not that one
    await env.DB.prepare('DELETE FROM libraries WHERE id = ?1').bind(shelf.id).run();
    const other = await createLibrary(env.DB, 'Someone else’s shelf');
    expect(other.id).toBe(shelf.id);
    const [row] = await listTrash(env.DB);
    expect(await restoreFromTrash(env.DB, row!.id, await members())).toEqual({ refused: 'no-shelf', shelf: 'Doomed shelf' });
    expect(await listTrash(env.DB)).toHaveLength(1); // still there, to restore once the shelf is back, or to let go
    const res = await as(asha, `/trash/${row!.id}/restore`, { body: {} });
    expect(res.headers.get('location')).toBe(`/trash?noshelf=${row!.id}`);
    expect(await html(asha, `/trash?noshelf=${row!.id}`)).toContain('its shelf “Doomed shelf” is no longer here');
    // a shelf of that name again, under any id: there
    const again = await createLibrary(env.DB, 'doomed shelf');
    const newId = await restored(row!.id);
    expect((await getItem(env.DB, newId))!.libraryId).toBe(again.id);
    // a shelf merely renamed keeps its items' restores: same id, the name the snapshot has is checked only when it differs
    const shelf2 = await createLibrary(env.DB, 'Before');
    const c2 = await book(asha, { libraryId: shelf2.id, title: 'Renamed shelf item' });
    await deleteItem(env.DB, c2.id, deleter(asha));
    await env.DB.prepare("UPDATE libraries SET name = 'After' WHERE id = ?1").bind(shelf2.id).run();
    const [row2] = await listTrash(env.DB);
    expect(await restoreFromTrash(env.DB, row2!.id, await members())).toEqual({ refused: 'no-shelf', shelf: 'Before' });
  });

  it('purges what is past its time on every delete, so the 30 days hold without anyone opening the page', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await env.COVERS.put('old-cover', 'x');
    const old = await book(asha, { libraryId: shelf.id, title: 'Old', coverKey: 'old-cover' });
    await deleteItem(env.DB, old.id, deleter(asha));
    await env.DB.prepare("UPDATE trash SET deleted_at = datetime('now', '-31 days')").run();
    const next = await book(asha, { libraryId: shelf.id, title: 'Next' });
    expect(await trashItems(env.DB, [next.id], deleter(asha))).toEqual({ trashed: 1, expired: ['old-cover'] });
    expect((await listTrash(env.DB)).map((r) => r.title)).toEqual(['Next']);
    // through the item page's delete, the purged row's cover object goes too
    await env.COVERS.put('old-cover-2', 'x');
    const aging = await book(asha, { libraryId: shelf.id, title: 'Aging', coverKey: 'old-cover-2' });
    await deleteItem(env.DB, aging.id, deleter(asha));
    await env.DB.prepare("UPDATE trash SET deleted_at = datetime('now', '-31 days')").run();
    const last = await book(asha, { libraryId: shelf.id, title: 'Last' });
    await as(asha, `/items/${last.id}/delete`, { body: {} });
    expect((await listTrash(env.DB)).map((r) => r.title)).toEqual(['Last']);
    expect(await env.COVERS.get('old-cover-2')).toBeNull();
  });
});

describe('the Trash page', () => {
  it('is an admin’s: lists what was deleted, restores, deletes for good, and purges what is past its time', async () => {
    const { asha, ravi, b } = await furnished();
    await as(ravi, `/items/${b.id}/delete`, { body: {} }); // any member may delete one item from its page
    expect((await as(ravi, '/trash')).status).toBe(403);
    expect((await as(ravi, '/trash/1/restore', { body: {} })).status).toBe(403);

    const text = await html(asha, '/trash');
    expect(text).toContain('<h1>Trash</h1>');
    expect(text).toContain('Piranesi');
    expect(text).toContain('by ravi');
    expect(text).toContain('action="/trash/');
    expect(await html(asha, '/')).toContain('href="/trash"');
    expect(await html(ravi, '/')).not.toContain('href="/trash"');

    const [row] = await listTrash(env.DB);
    const res = await as(asha, `/trash/${row!.id}/restore`, { body: {} });
    expect(res.status).toBe(302);
    const newId = Number(res.headers.get('location')!.match(/restored=(\d+)/)![1]);
    expect(await html(asha, `/trash?restored=${newId}`)).toContain(`href="/items/${newId}"`);
    expect(await html(asha, '/trash')).toContain('Nothing in the trash.');

    // delete for good: the row and the cover go
    await as(asha, `/items/${newId}/delete`, { body: {} });
    const [again] = await listTrash(env.DB);
    expect(await env.COVERS.get('cover-piranesi')).not.toBeNull();
    expect((await as(asha, `/trash/${again!.id}/discard`, { body: {} })).status).toBe(302);
    expect(await listTrash(env.DB)).toEqual([]);
    expect(await env.COVERS.get('cover-piranesi')).toBeNull();
  });

  it('purges rows older than 30 days, covers included, when the page is opened', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await env.COVERS.put('old-cover', 'x');
    const old = await book(asha, { libraryId: shelf.id, title: 'Old', coverKey: 'old-cover' });
    const fresh = await book(asha, { libraryId: shelf.id, title: 'Fresh' });
    await deleteItem(env.DB, old.id, deleter(asha));
    await deleteItem(env.DB, fresh.id, deleter(asha));
    await env.DB.prepare("UPDATE trash SET deleted_at = datetime('now', '-31 days') WHERE title = 'Old'").run();
    expect(await purgeTrash(env.DB)).toEqual(['old-cover']);
    expect((await listTrash(env.DB)).map((r) => r.title)).toEqual(['Fresh']);
    // the page does the same sweep and deletes the objects
    await env.COVERS.put('old-cover-2', 'x');
    const older = await book(asha, { libraryId: shelf.id, title: 'Older', coverKey: 'old-cover-2' });
    await deleteItem(env.DB, older.id, deleter(asha));
    await env.DB.prepare("UPDATE trash SET deleted_at = datetime('now', '-31 days') WHERE title = 'Older'").run();
    const text = await html(asha, '/trash');
    expect(text).not.toContain('Older');
    expect(text).toContain('Fresh');
    expect(await env.COVERS.get('old-cover-2')).toBeNull();
  });
});
