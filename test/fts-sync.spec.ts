// The search index's update trigger (migrations/0054): it fires only when one of the six indexed columns — title,
// creators, description, notes, location, original_title — changes. Before, every UPDATE of an item deleted and
// re-inserted its index row, so a refreshReadState() over items whose reading hadn't moved wrote three rows per item
// for one of use, against D1's rows-written-a-day on the free tier. The index must still follow each of the six.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, refreshReadState, searchItems, updateItem } from '../src/db/queries';
import { book, member, rows } from './member-helpers';

const ids = (found: Array<{ id: number }>) => found.map((i) => i.id);

describe('the search index and updates to items', () => {
  it('writes no index rows for a refreshReadState over items whose reading hasn’t changed', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Shelf');
    const held: number[] = [];
    for (let i = 0; i < 5; i++) held.push((await book(asha, { libraryId: shelf.id, title: `Book ${i}` })).id);

    const { meta } = await refreshReadState(env.DB, held).run();

    expect(meta.changes).toBe(held.length);
    expect(meta.rows_written).toBe(held.length); // the items themselves, and nothing in the index — three times that before
    // the index is whole, and still finds each of them
    await env.DB.prepare("INSERT INTO items_fts(items_fts) VALUES('integrity-check')").run();
    expect(ids(await searchItems(env.DB, 'book 3'))).toEqual([held[3]!]);
  });

  it('follows a change to each indexed column — the new value found, the old one not — and no other', async () => {
    const asha = await member('asha', 'admin');
    const item = await book(asha, { title: 'Alpha', creators: 'Bravo', description: 'Charlie', notes: 'Delta', location: 'Echo', originalTitle: 'Foxtrot' });
    const edits = [
      ['title', 'Alpha', 'Golf'],
      ['creators', 'Bravo', 'Hotel'],
      ['description', 'Charlie', 'India'],
      ['notes', 'Delta', 'Juliet'],
      ['location', 'Echo', 'Kilo'],
      ['originalTitle', 'Foxtrot', 'Lima'],
    ] as const;
    for (const [column, before, after] of edits) {
      expect(ids(await searchItems(env.DB, before)), `${column} before`).toEqual([item.id]);
      await updateItem(env.DB, item.id, { [column]: after });
      expect(ids(await searchItems(env.DB, after)), `${column} after`).toEqual([item.id]);
      expect(await searchItems(env.DB, before), `${column} gone`).toEqual([]);
    }
    // the trigger names exactly the index's columns, in SQLite's own record of it
    const [trigger] = await rows<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'items_fts_au'");
    expect(trigger!.sql).toMatch(/AFTER UPDATE OF `title`, `creators`, `description`, `notes`, `location`, `original_title` ON `items`/);
    const cols = await rows<{ name: string }>("SELECT name FROM pragma_table_info('items_fts')");
    expect(cols.map((c) => c.name)).toEqual(['title', 'creators', 'description', 'notes', 'location', 'original_title']);

    // a column outside the index — copies, a page, the shelf — leaves it alone: the item alone is written
    const { meta } = await env.DB.prepare('UPDATE items SET read_count = read_count, progress_page = 12 WHERE id = ?1').bind(item.id).run();
    expect(meta.rows_written).toBe(1);
    await env.DB.prepare("INSERT INTO items_fts(items_fts) VALUES('integrity-check')").run();
    expect(ids(await searchItems(env.DB, 'golf hotel'))).toEqual([item.id]);
  });
});
