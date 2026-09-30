// Where it lives (ARCH.md §16 #51): a free-text location on every item — "study, 2nd shelf", "Loft · box 3". Edited on
// the item form (adding and editing), shown on the item page, found by global and shelf search, carried through
// /export.csv and back. Private like notes: never on a share page, never to a connection — not on a shelf, an item's
// page or the feed — and never a key of toPublicItem or toConnectionItem.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView } from '../src/db/federation';
import { createLibrary, createShare, deleteItem, getItem, searchItems, setDisplayName, updateItem, updateSiteSettings } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { toConnectionItem, toFeedItem } from '../src/federation/items';
import { clearSharedViewsCache } from '../src/federation/routes';
import { EXPORT_COLUMNS, mapLibibRow, mapNalandaRow } from '../src/lib/csv';
import { newShareToken, shareFilters, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, setUpA, type Peer } from './federation-helpers';
import { as, book, html, member, rows } from './member-helpers';

/** Distinctive enough that nothing else on a page could contain it. */
const SECRET = 'Loft · box 3, zqxw crate';
const TOKEN = 'zqxw';
const today = () => new Date().toISOString().slice(0, 10);

const idFrom = (res: Response) => Number(res.headers.get('location')!.match(/\/items\/(\d+)/)![1]);
const setLocation = (id: number, location: string | null) =>
  // straight to the column: updated_at stays put, so a page served before and after can be compared byte for byte
  env.DB.prepare('UPDATE items SET location = ?1 WHERE id = ?2').bind(location, id).run();

// ---------- editing ----------

describe('where it lives: adding and editing', () => {
  it('is set on the add form, shown on the item page, changed and cleared on the edit form', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Books');
    const added = await as(asha, '/items', {
      body: { title: 'Piranesi', libraryId: String(shelf.id), mediaType: 'book', location: '  Study,\n 2nd   shelf ' },
    });
    expect(added.status).toBe(302);
    const id = idFrom(added);
    // one line, spaces collapsed: a pasted line break would only hide half of it
    expect((await getItem(env.DB, id))!.location).toBe('Study, 2nd shelf');

    const page = await html(asha, `/items/${id}`);
    expect(page).toContain('<dt>Location</dt><dd>Study, 2nd shelf</dd>');

    const form = await html(asha, `/items/${id}/edit`);
    expect(form).toContain('name="location" value="Study, 2nd shelf"');

    const saved = await as(asha, `/items/${id}`, {
      body: { title: 'Piranesi', libraryId: String(shelf.id), mediaType: 'book', location: SECRET },
    });
    expect(saved.status).toBe(302);
    expect((await getItem(env.DB, id))!.location).toBe(SECRET);
    expect(await html(asha, `/items/${id}`)).toContain(`<dd>${SECRET}</dd>`);

    await as(asha, `/items/${id}`, { body: { title: 'Piranesi', libraryId: String(shelf.id), mediaType: 'book', location: '   ' } });
    expect((await getItem(env.DB, id))!.location).toBeNull();
    expect(await html(asha, `/items/${id}`)).not.toContain('<dt>Location</dt>'); // no empty row
  });

  it('is a member’s to set as much as an admin’s, and the manual add form offers it', async () => {
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Games');
    expect(await html(ravi, '/add')).toContain('name="location"');
    const id = idFrom(await as(ravi, '/items', { body: { title: 'Catan', libraryId: String(shelf.id), mediaType: 'boardgame', location: 'Hall cupboard' } }));
    expect((await getItem(env.DB, id))!.location).toBe('Hall cupboard');
  });
});

// ---------- search ----------

describe('where it lives: search', () => {
  it('finds items by location in global search, and follows a change of location', async () => {
    const asha = await member('asha', 'admin');
    const loft = await book(asha, { title: 'The Dispossessed', creators: 'Ursula K. Le Guin', location: SECRET });
    const study = await book(asha, { title: 'Kindred', creators: 'Octavia E. Butler', location: 'Study, 2nd shelf' });

    expect((await searchItems(env.DB, TOKEN)).map((i) => i.id)).toEqual([loft.id]);
    expect((await searchItems(env.DB, 'box 3')).map((i) => i.id)).toEqual([loft.id]);
    expect((await searchItems(env.DB, '2nd shelf')).map((i) => i.id)).toEqual([study.id]);
    const page = await html(asha, `/search?q=${encodeURIComponent('loft')}`);
    expect(page).toContain('The Dispossessed');
    expect(page).not.toContain('Kindred');

    // the update trigger keeps the index in step: the old place no longer finds it, the new one does
    await updateItem(env.DB, loft.id, { location: 'Garage' });
    expect(await searchItems(env.DB, TOKEN)).toEqual([]);
    expect((await searchItems(env.DB, 'garage')).map((i) => i.id)).toEqual([loft.id]);
    await updateItem(env.DB, loft.id, { location: null });
    expect(await searchItems(env.DB, 'garage')).toEqual([]);
  });

  it('keeps finding titles, creators, descriptions and notes, and keeps the index consistent through deletes', async () => {
    const asha = await member('asha', 'admin');
    const item = await book(asha, {
      title: 'The Left Hand of Darkness',
      creators: 'Ursula K. Le Guin',
      description: 'An envoy in winter.',
      notes: 'Signed copy',
      location: 'Bedroom',
    });
    for (const q of ['left hand', 'le guin', 'envoy', 'signed', 'bedroom']) {
      expect((await searchItems(env.DB, q)).map((i) => i.id), q).toEqual([item.id]);
    }
    await deleteItem(env.DB, item.id);
    for (const q of ['left hand', 'bedroom']) expect(await searchItems(env.DB, q), q).toEqual([]);
    // an external-content index whose deletes didn't match what it holds fails this
    await env.DB.prepare("INSERT INTO items_fts(items_fts) VALUES('integrity-check')").run();
    const cols = await rows<{ name: string }>("SELECT name FROM pragma_table_info('items_fts')");
    expect(cols.map((c) => c.name)).toEqual(['title', 'creators', 'description', 'notes', 'location']);
  });

  it('finds items by location in a shelf’s search box', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    await book(asha, { libraryId: shelf.id, title: 'Kind of Blue', location: 'Living room crate' });
    await book(asha, { libraryId: shelf.id, title: 'Blue Train', location: 'Loft' });
    const page = await html(asha, `/libraries/${shelf.id}?q=crate`);
    expect(page).toContain('Kind of Blue');
    expect(page).not.toContain('Blue Train');
    expect(await html(asha, `/libraries/${shelf.id}?q=blue`)).toContain('Blue Train'); // titles still match
  });

  it('is never a published view’s filter: a share link captures no search text', async () => {
    const shelf = await createLibrary(env.DB, 'Records');
    const share = await createShare(env.DB, { token: newShareToken(), name: 'All', libraryId: shelf.id, tag: 'jazz' });
    // the shelf box's `q` matches locations, so a view that carried it would publish where things are kept
    expect(shareFilters(share)).not.toHaveProperty('q');
    expect(Object.keys(share)).not.toContain('q');
  });
});

// ---------- CSV ----------

describe('where it lives: CSV', () => {
  it('is exported beside the notes, and a Nalanda export maps it back', async () => {
    const asha = await member('asha', 'admin');
    await book(asha, { title: 'Piranesi', notes: 'Gift', location: SECRET });
    expect(EXPORT_COLUMNS.indexOf('location')).toBe(EXPORT_COLUMNS.indexOf('notes') + 1);
    const csv = await html(asha, '/export.csv');
    const [header, line] = csv.split('\r\n');
    expect(header!.split(',')).toEqual([...EXPORT_COLUMNS]);
    expect(line).toContain(`Gift,"${SECRET}",`); // quoted, for its comma

    const row = (location: string) =>
      mapNalandaRow({ title: 'T', media_type: 'book', isbn10_upc: '', began_on: '', completed_on: '', added_at: '', details: '', location })!.item;
    expect(row(SECRET).location).toBe(SECRET);
    expect(row('').location).toBeNull();
    // an export from before locations has no such column
    expect(mapNalandaRow({ title: 'T', media_type: 'book', isbn10_upc: '', began_on: '', completed_on: '', added_at: '', details: '' })!.item.location).toBeNull();
  });

  it('maps a libib-style location column to the private field, never into details, which share pages show', () => {
    const m = mapLibibRow({ title: 'Dune', Location: SECRET, ensemble: 'kept' }, { defaultType: 'book', musicAsVinyl: true })!;
    expect(m.item.location).toBe(SECRET);
    expect(JSON.parse(m.item.details!)).toEqual({ ensemble: 'kept' });
  });
});

// ---------- never published ----------

describe('where it lives: never outside the app', () => {
  it('is not a key of the share whitelist, a connection item or a feed item', async () => {
    const asha = await member('asha', 'admin');
    const item = { ...(await book(asha, { title: 'Piranesi', rating: 8, review: 'Tides', location: SECRET })) };
    const outside = [toPublicItem(item, { progress: true, reviews: [] }), toConnectionItem(item), toFeedItem(item, 'reviewed', '0123456789abcdef')];
    for (const o of outside) {
      expect(o).not.toHaveProperty('location');
      expect(JSON.stringify(o)).not.toContain(TOKEN);
    }
  });

  it('never reaches a share page — listing or item, with progress and names on — and changes no byte of one', async () => {
    const asha = await member('asha', 'admin');
    await setDisplayName(env.DB, asha.id, 'Asha');
    await updateSiteSettings(env.DB, { progressOnShares: true, namesOnShares: true });
    const shelf = await createLibrary(env.DB, 'Fiction');
    const item = await book(asha, { libraryId: shelf.id, title: 'Piranesi', rating: 8, review: 'Tides', status: 'in_progress', beganOn: today() });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: shelf.id });
    const pages = async () => {
      clearSharePageCache();
      return [await (await as(null, `/share/${share.token}`)).text(), await (await as(null, `/share/${share.token}/items/${item.id}`)).text()];
    };
    const without = await pages();
    await setLocation(item.id, SECRET);
    const withIt = await pages();
    for (const p of withIt) expect(p).not.toContain(TOKEN);
    expect(withIt).toEqual(without);
    expect(withIt[1]).toContain('Piranesi'); // the page did render the item

    // and through the edit form too, which also moves updated_at
    await as(asha, `/items/${item.id}`, { body: { title: 'Piranesi', libraryId: String(shelf.id), mediaType: 'book', status: 'in_progress', beganOn: today(), location: SECRET } });
    expect((await getItem(env.DB, item.id))!.location).toBe(SECRET);
    for (const p of await pages()) expect(p).not.toContain(TOKEN);
  });

  describe('to connections', () => {
    let a: ReturnType<typeof instanceA>;
    let peer: Peer;
    let viewId: number;
    beforeEach(async () => {
      const keys = await makeKeys();
      a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
      answerOutbound(() => json({}, 404));
      clearSharedViewsCache();
      await setUpA();
      peer = await makePeer('Riverbank library');
      await connectPeer(peer);
      viewId = (await createConnectionView(env.DB, { name: 'All', libraryId: null, mediaType: null, status: null, owned: null })).id;
    });
    afterEach(() => vi.unstubAllGlobals());

    /** Everything a connection can fetch about the item: the shelf, its page, and the feed. */
    const served = async (itemId: number) => [
      await (await a.signedGet(`/federation/shelf?view=${viewId}&page=1`, peer)).text(),
      await (await a.signedGet(`/federation/item?view=${viewId}&id=${itemId}`, peer)).text(),
      await (await a.signedGet(`/federation/feed?view=${viewId}&since=0`, peer)).text(),
    ];

    it('never reaches a connection’s shelf, item page or feed — names off or on — and changes no byte of them', async () => {
      const asha = await member('asha', 'admin');
      await setDisplayName(env.DB, asha.id, 'Asha');
      const item = await book(asha, { title: 'Piranesi', rating: 8, review: 'Tides', status: 'completed', completedOn: today() });
      for (const names of [false, true]) {
        await updateSiteSettings(env.DB, { namesToConnections: names });
        await setLocation(item.id, null);
        const without = await served(item.id);
        expect(without[1], `names ${names}`).toContain('Piranesi');
        expect(JSON.parse(without[2]!).entries.length, `names ${names}`).toBeGreaterThan(0);
        await setLocation(item.id, SECRET);
        const withIt = await served(item.id);
        for (const body of withIt) expect(body, `names ${names}`).not.toContain(TOKEN);
        expect(withIt, `names ${names}`).toEqual(without);
      }
    });

    it('records no activity when only the location changes', async () => {
      const asha = await member('asha', 'admin');
      const shelf = await createLibrary(env.DB, 'Fiction');
      const item = await book(asha, { libraryId: shelf.id, title: 'Piranesi', rating: 8, review: 'Tides', status: 'completed', completedOn: today() });
      const log = async () => [await rows('SELECT * FROM activity_log ORDER BY id'), await rows('SELECT * FROM member_activity ORDER BY id')];
      const before = await log();
      expect(before[0]!.length).toBeGreaterThan(0); // the view records activity
      const saved = await as(asha, `/items/${item.id}`, {
        body: { title: 'Piranesi', libraryId: String(shelf.id), mediaType: 'book', status: 'completed', completedOn: today(), rating: '8', review: 'Tides', location: SECRET },
      });
      expect(saved.status).toBe(302);
      expect((await getItem(env.DB, item.id))!.location).toBe(SECRET);
      expect(await log()).toEqual(before);
    });
  });
});
