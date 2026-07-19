// Integration: real D1 (workerd) with migrations applied — exercises schema,
// FTS5 triggers, tags, loans, and the import batch path end to end.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeLoanForItem,
  createItem,
  createLibrary,
  createLoan,
  createShare,
  createUser,
  deleteShare,
  getItem,
  getShareByToken,
  importItems,
  listItems,
  listShares,
  mergeImportItems,
  returnLoan,
  rotateShare,
  searchItems,
  setItemTags,
  tagsForItem,
  updateItem,
} from '../src/db/queries';

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

    const vinylOnly = await listItems(env.DB, lib.id, { mediaType: 'vinyl' });
    expect(vinylOnly.total).toBe(1);
    expect(vinylOnly.items[0]?.title).toBe('A Record');
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
    const active = await activeLoanForItem(env.DB, item.id);
    expect(active?.borrower).toBe('Priya');
    await returnLoan(env.DB, active!.id);
    expect(await activeLoanForItem(env.DB, item.id)).toBeNull();
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
    expect(n).toBe(25);
    const { total } = await listItems(env.DB, lib.id, {});
    expect(total).toBe(25);
    const found = await searchItems(env.DB, 'imported 7');
    expect(found.length).toBeGreaterThan(0);
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
    expect(result).toEqual({ merged: 1, inserted: 1 });

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
    expect(result).toEqual({ merged: 1, inserted: 0 });
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
    expect(await mergeImportItems(env.DB, rows)).toEqual({ merged: 0, inserted: 1 });
    expect(await mergeImportItems(env.DB, rows)).toEqual({ merged: 1, inserted: 0 });
    const { total } = await listItems(env.DB, lib.id, {});
    expect(total).toBe(1);
  });
});
