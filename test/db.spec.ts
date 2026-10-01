// Integration: real D1 (workerd) with migrations applied — exercises schema,
// FTS5 triggers, tags, loans, and the import batch path end to end.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeLoansForItem,
  createItem,
  createLibrary,
  createLoan,
  createShare,
  createUser,
  deleteShare,
  getItem,
  getShareByToken,
  holdingsByType,
  importItems,
  listItems,
  listLibraries,
  listShares,
  mergeImportItems,
  returnLoan,
  rotateShare,
  searchItems,
  setItemTags,
  shelvesWithTotals,
  tagsForItem,
  updateItem,
  deleteItem,
} from '../src/db/queries';
import { budgeted } from '../src/federation/budget';
import { itemStamp } from '../src/federation/items';

async function seedLibrary() {
  return createLibrary(env.DB, 'Test shelf');
}

describe('items + FTS', () => {
  it('finds items via FTS after insert and update', async () => {
    const lib = await seedLibrary();
    const item = await createItem(env.DB, {
      libraryId: lib.id,
      mediaType: 'book',
      title: 'The Left Hand of Darkness',
      creators: 'Ursula K. Le Guin',
      details: '{}',
    });

    const byTitle = await searchItems(env.DB, 'left hand');
    expect(byTitle.map((i) => i.id)).toContain(item.id);

    const byAuthor = await searchItems(env.DB, 'le guin');
    expect(byAuthor.map((i) => i.id)).toContain(item.id);

    await updateItem(env.DB, item.id, { title: 'The Dispossessed' });
    expect((await searchItems(env.DB, 'left hand')).map((i) => i.id)).not.toContain(item.id);
    expect((await searchItems(env.DB, 'dispossessed')).map((i) => i.id)).toContain(item.id);
  });

  it('filters and paginates library listings', async () => {
    const lib = await seedLibrary();
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'B Book', details: '{}' });
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'vinyl', title: 'A Record', details: '{}' });

    const all = await listItems(env.DB, lib.id, { sort: 'title' });
    expect(all.total).toBe(2);
    expect(all.items[0]?.title).toBe('A Record');

    const vinylOnly = await listItems(env.DB, lib.id, { mediaTypes: ['vinyl'] });
    expect(vinylOnly.total).toBe(1);
    expect(vinylOnly.items[0]?.title).toBe('A Record');
  });

  it('filters are any-of: multiple types/statuses combine as OR within the dimension', async () => {
    const lib = await seedLibrary();
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'Book', status: 'completed', details: '{}' });
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'vinyl', title: 'Record', status: 'not_started', details: '{}' });
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'boardgame', title: 'Game', status: 'in_progress', details: '{}' });

    const twoTypes = await listItems(env.DB, lib.id, { mediaTypes: ['book', 'vinyl'], sort: 'title' });
    expect(twoTypes.items.map((i) => i.title)).toEqual(['Book', 'Record']);

    const twoStatuses = await listItems(env.DB, lib.id, { statuses: ['completed', 'in_progress'], sort: 'title' });
    expect(twoStatuses.items.map((i) => i.title)).toEqual(['Book', 'Game']);

    // dimensions still AND together
    const both = await listItems(env.DB, lib.id, { mediaTypes: ['book', 'vinyl'], statuses: ['completed'] });
    expect(both.items.map((i) => i.title)).toEqual(['Book']);

    expect((await listItems(env.DB, lib.id, { mediaTypes: [], statuses: [] })).total).toBe(3); // empty = no filter
  });

  it('sorts by date completed, most recent first, undated items last', async () => {
    const lib = await seedLibrary();
    const older = await createItem(env.DB, {
      libraryId: lib.id,
      mediaType: 'book',
      title: 'Finished Long Ago',
      status: 'completed',
      completedOn: '2024-01-01',
      details: '{}',
    });
    const newer = await createItem(env.DB, {
      libraryId: lib.id,
      mediaType: 'book',
      title: 'Finished Recently',
      status: 'completed',
      completedOn: '2025-06-15',
      details: '{}',
    });
    const unfinished = await createItem(env.DB, {
      libraryId: lib.id,
      mediaType: 'book',
      title: 'Still Reading',
      status: 'in_progress',
      details: '{}',
    });

    const byCompleted = await listItems(env.DB, lib.id, { sort: 'completed' });
    expect(byCompleted.items.map((i) => i.id)).toEqual([newer.id, older.id, unfinished.id]);
  });

  it('filters by ownership: copies = 0 is a reading-log entry', async () => {
    const lib = await seedLibrary();
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'Owned', copies: 1, details: '{}' });
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'Logged', copies: 0, details: '{}' });

    const owned = await listItems(env.DB, lib.id, { owned: true });
    expect(owned.items.map((i) => i.title)).toEqual(['Owned']);
    const logged = await listItems(env.DB, lib.id, { owned: false });
    expect(logged.items.map((i) => i.title)).toEqual(['Logged']);
    expect((await listItems(env.DB, lib.id, {})).total).toBe(2);
  });

  it('holdingsByType splits owned/not-owned per media type, largest type first', async () => {
    const lib = await seedLibrary();
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'B1', copies: 1, details: '{}' });
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'B2', copies: 0, details: '{}' });
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'B3', copies: 0, details: '{}' });
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'boardgame', title: 'G1', copies: 2, details: '{}' });

    expect(await holdingsByType(env.DB)).toEqual([
      { mediaType: 'book', owned: 1, notOwned: 2 },
      { mediaType: 'boardgame', owned: 1, notOwned: 0 },
    ]);
  });

  it('the Overview’s holdings, from the shelves’ one pass, are holdingsByType()’s — ties in descending type order', async () => {
    // §16 #68: the Overview reads them with the shelves and their totals; the order, ties included, must not move
    const lib = await seedLibrary();
    const other = await createLibrary(env.DB, 'Elsewhere');
    for (const [libraryId, mediaType, copies] of [
      [lib.id, 'book', 1], [other.id, 'book', 0], [lib.id, 'book', 2],
      [lib.id, 'boardgame', 1], [other.id, 'vinyl', 0], [lib.id, 'movie', 1], [other.id, 'movie', 0],
    ] as const) {
      await createItem(env.DB, { libraryId, mediaType, title: `${mediaType} ${copies}`, copies, details: '{}' });
    }
    const expected = [
      { mediaType: 'book', owned: 2, notOwned: 1 },
      { mediaType: 'movie', owned: 1, notOwned: 1 },
      { mediaType: 'vinyl', owned: 0, notOwned: 1 }, // tied at one item with boardgame: descending type order
      { mediaType: 'boardgame', owned: 1, notOwned: 0 },
    ];
    expect(await holdingsByType(env.DB)).toEqual(expected);
    const { shelves, holdings, totals } = await shelvesWithTotals(env.DB);
    expect(holdings).toEqual(expected);
    // and each shelf's count is listLibraries()'s
    expect(shelves).toEqual(await listLibraries(env.DB));
    expect(totals.shelves.get(lib.id)?.items).toBe(4);
  });

  it('filters by name across title and creators, case-insensitive, LIKE-safe', async () => {
    const lib = await seedLibrary();
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'The Dispossessed', creators: 'Ursula K. Le Guin', details: '{}' });
    await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: '100% Wrong', creators: 'Someone Else', details: '{}' });

    expect((await listItems(env.DB, lib.id, { q: 'dispossessed' })).items.map((i) => i.title)).toEqual(['The Dispossessed']);
    expect((await listItems(env.DB, lib.id, { q: 'le guin' })).items.map((i) => i.title)).toEqual(['The Dispossessed']); // creators match
    expect((await listItems(env.DB, lib.id, { q: '100%' })).items.map((i) => i.title)).toEqual(['100% Wrong']); // % is literal, not a wildcard
    expect((await listItems(env.DB, lib.id, { q: 'zzz' })).total).toBe(0);
    // composes with other filters
    expect((await listItems(env.DB, lib.id, { q: 'guin', owned: true })).total).toBe(1);
  });
});

describe('tags', () => {
  it('normalizes, replaces, and reads back tags', async () => {
    const lib = await seedLibrary();
    const item = await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'Tagged', details: '{}' });
    await setItemTags(env.DB, item.id, [' Sci-Fi ', 'CLASSICS', 'sci-fi']);
    expect(await tagsForItem(env.DB, item.id)).toEqual(['classics', 'sci-fi']);
    await setItemTags(env.DB, item.id, ['new-only']);
    expect(await tagsForItem(env.DB, item.id)).toEqual(['new-only']);
  });
});

describe('loans', () => {
  it('tracks lend and return', async () => {
    const lib = await seedLibrary();
    const item = await createItem(env.DB, { libraryId: lib.id, mediaType: 'boardgame', title: 'Cascadia', details: '{}' });
    await createLoan(env.DB, { itemId: item.id, borrower: 'Priya' });
    const [active] = await activeLoansForItem(env.DB, item.id);
    expect(active?.borrower).toBe('Priya');
    await returnLoan(env.DB, active!.id);
    expect(await activeLoansForItem(env.DB, item.id)).toEqual([]);
  });
});

describe('share views', () => {
  it('publishes, rotates, and removes view links', async () => {
    const lib = await seedLibrary();
    const view = await createShare(env.DB, {
      token: 'deadbeefdeadbeefdeadbeefdeadbeef',
      name: 'My reviews',
      libraryId: lib.id,
      owned: false,
    });
    expect((await getShareByToken(env.DB, view.token))?.name).toBe('My reviews');

    await rotateShare(env.DB, view.id, 'cafebabecafebabecafebabecafebabe');
    expect(await getShareByToken(env.DB, 'deadbeefdeadbeefdeadbeefdeadbeef')).toBeNull(); // old URL dead
    expect((await getShareByToken(env.DB, 'cafebabecafebabecafebabecafebabe'))?.id).toBe(view.id);

    expect((await listShares(env.DB, lib.id)).length).toBe(1);
    await deleteShare(env.DB, view.id);
    expect(await listShares(env.DB, lib.id)).toEqual([]);
  });
});

describe('bulk import', () => {
  it('inserts rows with tags in batches', async () => {
    const lib = await seedLibrary();
    const user = await createUser(env.DB, {
      username: 'admin',
      passwordHash: 'pbkdf2$1$x$y',
      role: 'admin',
      mustChangePassword: false,
    });
    const n = await importItems(
      env.DB,
      Array.from({ length: 25 }, (_, i) => ({
        item: { libraryId: lib.id, mediaType: 'book' as const, title: `Imported ${i}`, details: '{}', addedBy: user.id },
        tags: i % 2 ? ['odd', 'imported'] : ['imported'],
      })),
    );
    expect(n).toHaveLength(25);
    const { total } = await listItems(env.DB, lib.id, {});
    expect(total).toBe(25);
    const found = await searchItems(env.DB, 'imported 7');
    expect(found.length).toBeGreaterThan(0);
  });

  it('links the tags inside the one batch, however many: one D1 call, and a failure there inserts nothing (§16 #39)', async () => {
    const lib = await seedLibrary();
    const budget = { left: 100 };
    const many = Array.from({ length: 300 }, (_, i) => `tag-${i}`);
    const ids = await importItems(budgeted(env.DB, budget), [{ item: { libraryId: lib.id, mediaType: 'book', title: 'Tagged', details: '{}' }, tags: many }]);
    expect(100 - budget.left).toBe(1);
    expect(await tagsForItem(env.DB, ids[0]!)).toHaveLength(300);
    await env.DB.prepare("CREATE TRIGGER fail_tags BEFORE INSERT ON item_tags BEGIN SELECT RAISE(ABORT, 'no tags today'); END").run();
    await expect(importItems(env.DB, [{ item: { libraryId: lib.id, mediaType: 'book', title: 'Lost', details: '{}' }, tags: ['x'] }])).rejects.toThrow();
    expect((await env.DB.prepare("SELECT id FROM items WHERE title = 'Lost'").all()).results).toEqual([]);
    await env.DB.prepare('DROP TRIGGER fail_tags').run();
  });
});

describe('goodreads match-and-merge import', () => {
  it('merges reading data onto ISBN matches, inserts the rest as reading-log entries', async () => {
    const lib = await seedLibrary();
    const owned = await createItem(env.DB, {
      libraryId: lib.id,
      mediaType: 'book',
      title: 'The Fifth Season',
      creators: 'N. K. Jemisin',
      isbn13: '9780316229296',
      copies: 1,
      rating: 6,
      details: '{}',
    });

    const result = await mergeImportItems(env.DB, [
      {
        // matches `owned` by ISBN — goodreads wins on rating/review/status
        item: {
          libraryId: lib.id,
          mediaType: 'book',
          title: 'The Fifth Season (The Broken Earth, #1)',
          isbn13: '9780316229296',
          status: 'completed',
          rating: 10,
          review: 'Stunning.',
          completedOn: '2024-03-10',
          copies: 0,
          details: '{}',
        },
        tags: ['sci-fi'],
      },
      {
        // no match anywhere — inserted as a copies=0 reading-log entry
        item: { libraryId: lib.id, mediaType: 'book', title: 'Piranesi', creators: 'Susanna Clarke', status: 'completed', copies: 0, details: '{}' },
        tags: [],
      },
    ]);
    expect(result).toEqual({ merged: 1, inserted: 1, reads: 2, dated: 0 }); // a finished read for each

    const after = await getItem(env.DB, owned.id);
    expect(after!.rating).toBe(10); // goodreads wins
    expect(after!.review).toBe('Stunning.');
    expect(after!.status).toBe('completed');
    expect(after!.completedOn).toBe('2024-03-10');
    expect(after!.copies).toBe(1); // ownership untouched
    expect(after!.title).toBe('The Fifth Season'); // metadata untouched
    expect(await tagsForItem(env.DB, owned.id)).toEqual(['sci-fi']);

    const { items } = await listItems(env.DB, lib.id, { owned: false });
    expect(items.map((i) => i.title)).toEqual(['Piranesi']);
  });

  it('matches by normalized title + author surname when there is no ISBN, and never blanks fields', async () => {
    const lib = await seedLibrary();
    const owned = await createItem(env.DB, {
      libraryId: lib.id,
      mediaType: 'book',
      title: 'The Dispossessed: An Ambiguous Utopia',
      creators: 'Ursula K. Le Guin',
      review: 'My old review.',
      copies: 1,
      details: '{}',
    });

    const result = await mergeImportItems(env.DB, [
      {
        item: {
          libraryId: lib.id,
          mediaType: 'book',
          title: 'The Dispossessed',
          creators: 'Ursula K. Le Guin',
          status: 'completed',
          rating: 8,
          copies: 0,
          details: '{}',
        },
        tags: [],
      },
    ]);
    expect(result).toEqual({ merged: 1, inserted: 0, reads: 1, dated: 0 });
    const after = await getItem(env.DB, owned.id);
    expect(after!.rating).toBe(8);
    expect(after!.review).toBe('My old review.'); // goodreads had none — not blanked
  });

  it('is idempotent across re-runs: first run inserts, second merges', async () => {
    const lib = await seedLibrary();
    const rows = [
      {
        item: {
          libraryId: lib.id,
          mediaType: 'book' as const,
          title: 'Piranesi',
          creators: 'Susanna Clarke',
          isbn13: '9781635575637',
          status: 'completed' as const,
          rating: 9,
          copies: 0,
          details: '{}',
        },
        tags: ['fantasy'],
      },
    ];
    expect(await mergeImportItems(env.DB, rows)).toEqual({ merged: 0, inserted: 1, reads: 1, dated: 0 });
    expect(await mergeImportItems(env.DB, rows)).toEqual({ merged: 1, inserted: 0, reads: 0, dated: 0 }); // its read is already here
    const { total } = await listItems(env.DB, lib.id, {});
    expect(total).toBe(1);
  });

  it('dates a new book from the file, and a matched one only when asked — keeping the stamp connections hold (§16 #90)', async () => {
    const lib = await seedLibrary();
    const here = await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'Piranesi', creators: 'Susanna Clarke', isbn13: '9781635575637', details: '{}' });
    const before = (await getItem(env.DB, here.id))!;
    const stamp = await itemStamp(before);
    const row = (title: string, isbn13: string, addedAt: string) => ({
      item: { libraryId: lib.id, mediaType: 'book' as const, title, creators: 'Susanna Clarke', isbn13, status: 'not_started' as const, copies: 0, details: '{}', addedAt },
      tags: [],
    });
    const piranesi = row('Piranesi', '9781635575637', '2019-03-12 00:00:00');

    // not asked: the match keeps its date, and the result counts what the box would change
    expect(await mergeImportItems(env.DB, [piranesi])).toEqual({ merged: 1, inserted: 0, reads: 0, dated: 1 });
    expect((await getItem(env.DB, here.id))!.addedAt).toBe(before.addedAt);
    // a dry run counts the same, and writes nothing
    expect(await mergeImportItems(env.DB, [piranesi], true, undefined, true)).toMatchObject({ dated: 1 });
    expect((await getItem(env.DB, here.id))!.addedAt).toBe(before.addedAt);

    // asked: the date moves, the row's own time is kept, and the stamp is as it was
    expect(await mergeImportItems(env.DB, [piranesi], false, undefined, true)).toMatchObject({ merged: 1, dated: 1 });
    const after = (await getItem(env.DB, here.id))!;
    expect(after.addedAt).toBe('2019-03-12 00:00:00');
    expect(after.createdAt).toBe(before.addedAt);
    expect(after.updatedAt).toBe(before.updatedAt); // nothing a connection sees changed
    expect(await itemStamp(after)).toBe(stamp);

    // the same date again changes nothing; a later date moves it once more, and the time kept is still the first
    expect(await mergeImportItems(env.DB, [piranesi], false, undefined, true)).toMatchObject({ dated: 0 });
    expect(await mergeImportItems(env.DB, [row('Piranesi', '9781635575637', '2020-01-01 00:00:00')], false, undefined, true)).toMatchObject({ dated: 1 });
    const again = (await getItem(env.DB, here.id))!;
    expect(again.addedAt).toBe('2020-01-01 00:00:00');
    expect(again.createdAt).toBe(before.addedAt);
    expect(await itemStamp(again)).toBe(stamp);

    // a row without a date never touches one, asked or not; a new book takes the file's date, asked or not
    expect(await mergeImportItems(env.DB, [{ ...piranesi, item: { ...piranesi.item, addedAt: undefined } }], false, undefined, true)).toMatchObject({ dated: 0 });
    expect((await getItem(env.DB, here.id))!.addedAt).toBe('2020-01-01 00:00:00');
    expect(await mergeImportItems(env.DB, [row('Jonathan Strange & Mr Norrell', '9781582344164', '2017-06-01 00:00:00')])).toMatchObject({ inserted: 1, dated: 0 });
    const { items } = await listItems(env.DB, lib.id, {});
    const fresh = items.find((i) => i.title === 'Jonathan Strange & Mr Norrell')!;
    expect(fresh.addedAt).toBe('2017-06-01 00:00:00');
    expect(fresh.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/); // a file-dated insert keeps its own time
  });

  it('stamps a book a file dates by the second it was made here, so a reused id names no other book (review on #130)', async () => {
    const lib = await seedLibrary();
    const row = (title: string, isbn13: string) => ({
      item: { libraryId: lib.id, mediaType: 'book' as const, title, creators: 'Susanna Clarke', isbn13, status: 'not_started' as const, copies: 0, details: '{}', addedAt: '2019-03-12 00:00:00' },
      tags: [],
    });
    await mergeImportItems(env.DB, [row('Piranesi', '9781635575637')]);
    // made a minute ago, for the test's sake: the stamp follows created_at, so a day in the file never decides it
    await env.DB.prepare(`UPDATE items SET created_at = datetime(created_at, '-1 minute')`).run();
    const first = (await listItems(env.DB, lib.id, {})).items[0]!;
    const stamp = await itemStamp(first);
    expect(stamp).not.toBe(await itemStamp({ ...first, createdAt: null }));

    await deleteItem(env.DB, first.id);
    await mergeImportItems(env.DB, [row('Jonathan Strange & Mr Norrell', '9781582344164')]);
    const second = (await listItems(env.DB, lib.id, {})).items[0]!;
    expect(second.id).toBe(first.id); // SQLite hands the newest id out again
    expect(second.addedAt).toBe(first.addedAt); // the same day in the file
    expect(await itemStamp(second)).not.toBe(stamp); // but not the same book, to a connection
  });
});
