// Integration: real D1 (workerd) with migrations applied — exercises schema,
// FTS5 triggers, tags, loans, and the import batch path end to end.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeLoanForItem,
  createItem,
  createLibrary,
  createLoan,
  createUser,
  getLibraryByShareToken,
  importItems,
  listItems,
  returnLoan,
  searchItems,
  setItemTags,
  setShareToken,
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

describe('share tokens', () => {
  it('publishes and revokes', async () => {
    const lib = await seedLibrary();
    await setShareToken(env.DB, lib.id, 'deadbeefdeadbeefdeadbeefdeadbeef');
    expect((await getLibraryByShareToken(env.DB, 'deadbeefdeadbeefdeadbeefdeadbeef'))?.id).toBe(lib.id);
    await setShareToken(env.DB, lib.id, null);
    expect(await getLibraryByShareToken(env.DB, 'deadbeefdeadbeefdeadbeefdeadbeef')).toBeNull();
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
