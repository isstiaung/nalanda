// Custom fields (ARCH.md §16 #95): up to ten household fields — text, yes/no, date — defined by an admin under
// Members, on every item form, kept in items.custom and never in details; private unless a field's own share
// switch is on, and then by name on the shared item's page only; never to connections. They round-trip through
// the CSV by name, ride in the trash snapshot, and show in History.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView } from '../src/db/federation';
import {
  createCustomField,
  createItem,
  createLibrary,
  createShare,
  deleteCustomField,
  deleteItem,
  getItem,
  getTrash,
  listCustomFields,
  listMembersWithKeys,
  listTrash,
  restoreFromTrash,
  updateItem,
  type TrashPayload,
} from '../src/db/queries';
import type { CustomField, CustomKind, Item } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { toConnectionItem, toItemDetail, toRecommendedItem } from '../src/federation/items';
import { clearSharedViewsCache } from '../src/federation/routes';
import { EXPORT_COLUMNS, mapGoodreadsRow, mapLibibRow, mapLibraryThingRow, mapNalandaRow, mapStoryGraphRow, PRIVATE_COLUMNS } from '../src/lib/csv';
import { checkCustomValue, cleanCustomName, CUSTOM_FIELD_LIMIT, customFromForm, formatCustomCell, parseCustomCell, publicCustom } from '../src/lib/custom';
import { newShareToken, toGiftItem, toPublicItem } from '../src/lib/share';
import app from '../src/index';
import { clearSharePageCache } from '../src/routes/share';
import { connectPeer, instanceA, makeKeys, makePeer, setUpA } from './federation-helpers';
import { as, book, html, member, rows, type Member } from './member-helpers';

/** A field, made as the panel makes one, read back with its id. */
async function field(name: string, kind: CustomKind, onShares = false): Promise<CustomField> {
  expect(await createCustomField(env.DB, { name, kind, onShares })).toBe('created');
  const made = (await listCustomFields(env.DB)).find((f) => f.name === name);
  if (!made) throw new Error(`field ${name} not made`);
  return made;
}

/** The three fields most tests use: text, yes/no and date, all private. */
async function threeFields() {
  return { gifted: await field('Gifted by', 'text'), signed: await field('Signed', 'bool'), bought: await field('Bought on', 'date') };
}

const customOf = async (id: number) => JSON.parse((await getItem(env.DB, id))!.custom) as Record<string, unknown>;

/** The item form's body, as the edit and add forms post it, with the custom fields' marker. */
const form = (shelf: number, values: Record<string, string> = {}) => ({ title: 'Piranesi', libraryId: String(shelf), mediaType: 'book', customForm: '1', ...values });

/** How many D1 calls a signed-in GET makes — a batch is one (§16 #37). */
async function calls(who: Member, path: string): Promise<number> {
  const budget = { left: 1000 };
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: { cookie: who.cookie } }), { ...env, DB: budgeted(env.DB, budget) } as Bindings, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status, path).toBe(200);
  await res.text();
  return 1000 - budget.left;
}

/** RFC 4180, as public/import.js parses it in the browser. */
function parseCsv(text: string): Record<string, string>[] {
  const out: string[][] = [];
  let fieldText = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        fieldText += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else fieldText += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(fieldText);
      fieldText = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(fieldText);
      out.push(row);
      row = [];
      fieldText = '';
    } else fieldText += ch;
  }
  if (fieldText || row.length) out.push([...row, fieldText]);
  const [header, ...body] = out;
  return body.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ''])));
}

// ---------- the Members panel ----------

describe('the Members panel', () => {
  it('is an admin’s: a member gets 403 on the page and on every custom-fields route', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const signed = await field('Signed', 'bool');
    expect((await as(ravi, '/settings/users')).status).toBe(403);
    expect((await as(ravi, '/settings/custom-fields', { body: { name: 'Gifted by', kind: 'text' } })).status).toBe(403);
    expect((await as(ravi, `/settings/custom-fields/${signed.id}`, { body: { name: 'Autographed' } })).status).toBe(403);
    expect((await as(ravi, `/settings/custom-fields/${signed.id}/delete`, { body: {} })).status).toBe(403);
    expect(await listCustomFields(env.DB)).toMatchObject([{ name: 'Signed' }]);
    // the admin's page lists the panel, with the field
    const page = await html(asha, '/settings/users');
    expect(page).toContain('Custom fields');
    expect(page).toContain('value="Signed"');
    expect(page).toContain('Every item&#39;s value for it is lost');
  });

  it('adds a field of each kind, renames and switches one, and refuses a second of the same name, case aside', async () => {
    const asha = await member('asha', 'admin');
    for (const [name, kind] of [['Gifted by', 'text'], ['Signed', 'bool'], ['Bought on', 'date']] as const) {
      const res = await as(asha, '/settings/custom-fields', { body: { name, kind } });
      expect(res.status, name).toBe(302);
      expect(res.headers.get('location')).toBe('/settings/users#custom-fields');
    }
    expect((await listCustomFields(env.DB)).map((f) => [f.name, f.kind, f.onShares, f.position])).toEqual([
      ['Gifted by', 'text', false, 1],
      ['Signed', 'bool', false, 2],
      ['Bought on', 'date', false, 3],
    ]);
    // a duplicate, however it is cased, and whatever else is wrong with the form
    const dup = await as(asha, '/settings/custom-fields', { body: { name: 'SIGNED', kind: 'text' } });
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain('There is already a field named “SIGNED”');
    expect((await as(asha, '/settings/custom-fields', { body: { name: '   ', kind: 'text' } })).status).toBe(400);
    expect((await as(asha, '/settings/custom-fields', { body: { name: 'x'.repeat(41), kind: 'text' } })).status).toBe(400);
    expect((await as(asha, '/settings/custom-fields', { body: { name: 'Edition', kind: 'number' } })).status).toBe(400);
    expect(await listCustomFields(env.DB)).toHaveLength(3);
    // rename and switch on, in one save; the kind stays
    const signed = (await listCustomFields(env.DB)).find((f) => f.name === 'Signed')!;
    expect((await as(asha, `/settings/custom-fields/${signed.id}`, { body: { name: 'Autographed', onShares: '1' } })).status).toBe(302);
    expect((await listCustomFields(env.DB)).find((f) => f.id === signed.id)).toMatchObject({ name: 'Autographed', kind: 'bool', onShares: true });
    // off again, and a rename onto another field's name is refused
    expect((await as(asha, `/settings/custom-fields/${signed.id}`, { body: { name: 'Autographed' } })).status).toBe(302);
    expect((await listCustomFields(env.DB)).find((f) => f.id === signed.id)).toMatchObject({ onShares: false });
    const taken = await as(asha, `/settings/custom-fields/${signed.id}`, { body: { name: 'gifted BY' } });
    expect(taken.status).toBe(400);
    expect(await taken.text()).toContain('There is already a field named');
    expect((await as(asha, '/settings/custom-fields/999', { body: { name: 'Nobody' } })).status).toBe(404);
  });

  it('caps at ten, refused with a reason — in the statement, so two adds at once can’t make eleven', async () => {
    const asha = await member('asha', 'admin');
    for (let i = 1; i <= CUSTOM_FIELD_LIMIT - 1; i++) await field(`Field ${i}`, 'text');
    // the tenth and an eleventh, sent together: exactly one lands
    const outcomes = await Promise.all([
      createCustomField(env.DB, { name: 'Tenth', kind: 'text', onShares: false }),
      createCustomField(env.DB, { name: 'Eleventh', kind: 'text', onShares: false }),
    ]);
    expect(outcomes.sort()).toEqual(['created', 'full']);
    expect(await listCustomFields(env.DB)).toHaveLength(CUSTOM_FIELD_LIMIT);
    const refused = await as(asha, '/settings/custom-fields', { body: { name: 'Twelfth', kind: 'date' } });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(`${CUSTOM_FIELD_LIMIT} fields is the limit`);
    // the page offers no add form at the cap, and says why
    const page = await html(asha, '/settings/users');
    expect(page).not.toContain('action="/settings/custom-fields" ');
    expect(page).toContain('delete one to add another');
  });

  it('deleting a field strips its value from every item in one batch, named in each item’s history, and the confirm says so', async () => {
    const asha = await member('asha', 'admin');
    const { gifted, signed } = await threeFields();
    const shelf = await createLibrary(env.DB, 'Books');
    const both = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title: 'Both', details: '{}', custom: JSON.stringify({ [gifted.id]: 'Ravi', [signed.id]: true }) });
    const one = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title: 'One', details: '{}', custom: JSON.stringify({ [signed.id]: true }) });
    const none = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title: 'None', details: '{}' });
    expect(await html(asha, '/settings/users')).toContain(`Delete the field “Gifted by”? Every item&#39;s value for it is lost`);

    // one D1 call: the strip and the delete are one batch
    const budget = { left: 1000 };
    expect(await deleteCustomField(budgeted(env.DB, budget), gifted.id, { id: asha.id, sessionKey: asha.sessionKey })).toBe(true);
    expect(1000 - budget.left).toBe(1);

    expect(await customOf(both.id)).toEqual({ [signed.id]: true });
    expect(await customOf(one.id)).toEqual({ [signed.id]: true });
    expect(await customOf(none.id)).toEqual({});
    expect((await listCustomFields(env.DB)).map((f) => f.name)).toEqual(['Signed', 'Bought on']);
    // history: the item that held a value changed, named to the admin; the others didn't
    const history = await rows<{ item_id: number; field: string; before: string; after: string; changed_by: number | null }>(
      "SELECT item_id, field, before, after, changed_by FROM item_history WHERE field = 'custom' ORDER BY id",
    );
    expect(history).toEqual([{ item_id: both.id, field: 'custom', before: JSON.stringify({ [gifted.id]: 'Ravi', [signed.id]: true }), after: JSON.stringify({ [signed.id]: true }), changed_by: asha.id }]);
    expect(await rows('SELECT * FROM acting')).toEqual([]);
    // through the route: a gone field is 404, a real one redirects
    expect((await as(asha, `/settings/custom-fields/${gifted.id}/delete`, { body: {} })).status).toBe(404);
    expect((await as(asha, `/settings/custom-fields/${signed.id}/delete`, { body: {} })).status).toBe(302);
    expect(await customOf(both.id)).toEqual({});
    expect((await listCustomFields(env.DB)).map((f) => f.name)).toEqual(['Bought on']);
  });
});

// ---------- the item form and page ----------

describe('the item form', () => {
  it('shows every field in order, labelled by name, with the item’s values — and no marker when there are none', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha);
    expect(await html(asha, `/items/${b.id}/edit`)).not.toContain('name="customForm"');
    expect(await html(asha, '/add')).not.toContain('name="customForm"');
    const { gifted, signed, bought } = await threeFields();
    await updateItem(env.DB, b.id, { custom: JSON.stringify({ [gifted.id]: 'Ravi', [signed.id]: true, [bought.id]: '2026-01-02' }) });
    const page = await html(asha, `/items/${b.id}/edit`);
    expect(page).toContain('name="customForm" value="1"');
    expect(page).toMatch(/<legend>\s*Fields/);
    const order = [page.indexOf('Gifted by'), page.indexOf('Signed'), page.indexOf('Bought on')];
    expect(order.every((i) => i > 0) && order[0]! < order[1]! && order[1]! < order[2]!).toBe(true);
    expect(page).toContain(`<input name="custom-${gifted.id}" value="Ravi" maxlength="500"`);
    expect(page).toContain(`<input type="checkbox" name="custom-${signed.id}" value="1" checked`);
    expect(page).toContain(`<input type="date" name="custom-${bought.id}" value="2026-01-02"`);
    // every control is inside a label
    expect(page.match(/<label[^>]*>\s*<input type="checkbox" name="custom-/)).not.toBeNull();
    // the Add page's manual form has them too, empty
    expect(await html(asha, '/add')).toContain(`<input name="custom-${gifted.id}" value="" maxlength="500"`);
  });

  it('validates each kind, refusing with role="alert" on the field and showing the rest again; saves what fits', async () => {
    const asha = await member('asha', 'admin');
    const { gifted, signed, bought } = await threeFields();
    const b = await book(asha);
    const shelf = b.libraryId;
    const edit = (values: Record<string, string>) => as(asha, `/items/${b.id}`, { body: form(shelf, { title: 'The Dispossessed', ...values }) });

    const badDate = await edit({ [`custom-${gifted.id}`]: 'Ravi', [`custom-${bought.id}`]: '2026-13-45' });
    expect(badDate.status).toBe(400);
    const shown = await badDate.text();
    expect(shown).toContain('<p class="error" role="alert" id="item-form-error">Bought on must be a date, as 2026-10-01.</p>');
    expect(shown).toContain(`<input type="date" name="custom-${bought.id}" value="2026-13-45" aria-invalid="true" aria-describedby="item-form-error"`);
    expect(shown).toContain(`<input name="custom-${gifted.id}" value="Ravi" maxlength="500"`); // what was typed beside it, shown again
    expect(await customOf(b.id)).toEqual({}); // nothing saved

    const longText = await edit({ [`custom-${gifted.id}`]: 'x'.repeat(501) });
    expect(longText.status).toBe(400);
    expect(await longText.text()).toContain('Gifted by holds at most 500 characters.');

    const oddBool = await edit({ [`custom-${signed.id}`]: 'yes' });
    expect(oddBool.status).toBe(400);
    expect(await oddBool.text()).toContain('Signed is a yes/no field.');

    // what fits: whitespace collapsed, an unticked box and a blank text unset
    const ok = await edit({ [`custom-${gifted.id}`]: '  Ravi   Menon ', [`custom-${signed.id}`]: '1', [`custom-${bought.id}`]: '2026-01-02' });
    expect(ok.status).toBe(302);
    expect(await customOf(b.id)).toEqual({ [gifted.id]: 'Ravi Menon', [signed.id]: true, [bought.id]: '2026-01-02' });
    expect((await edit({ [`custom-${gifted.id}`]: '', [`custom-${bought.id}`]: '' })).status).toBe(302);
    expect(await customOf(b.id)).toEqual({});
  });

  it('saves on add and on edit; writes nothing from a form without the marker or a household without fields', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Books');
    // no fields yet: a form with the marker still writes nothing
    expect((await as(asha, '/items', { body: form(shelf.id, { 'custom-1': 'Ravi' }) })).status).toBe(302);
    const first = (await rows<{ id: number; custom: string }>('SELECT id, custom FROM items ORDER BY id DESC LIMIT 1'))[0]!;
    expect(first.custom).toBe('{}');

    const { gifted, signed } = await threeFields();
    // add, with values
    const added = await as(asha, '/items', { body: form(shelf.id, { title: 'Added', [`custom-${gifted.id}`]: 'Priya', [`custom-${signed.id}`]: '1' }) });
    expect(added.status).toBe(302);
    const addedId = Number(added.headers.get('location')!.match(/\/items\/(\d+)/)![1]);
    expect(await customOf(addedId)).toEqual({ [gifted.id]: 'Priya', [signed.id]: true });
    // a scan's add carries no marker: '{}'
    const scanned = await as(asha, '/items', { body: { title: 'Scanned', libraryId: String(shelf.id), mediaType: 'book', [`custom-${gifted.id}`]: 'Priya' } });
    expect(scanned.status).toBe(302);
    expect(await customOf(Number(scanned.headers.get('location')!.match(/\/items\/(\d+)/)![1]))).toEqual({});
    // an edit from a form without the marker (opened before the fields existed) leaves the values alone
    expect((await as(asha, `/items/${addedId}`, { body: { title: 'Added', libraryId: String(shelf.id), mediaType: 'book' } })).status).toBe(302);
    expect(await customOf(addedId)).toEqual({ [gifted.id]: 'Priya', [signed.id]: true });
    // and one with it replaces them
    expect((await as(asha, `/items/${addedId}`, { body: form(shelf.id, { title: 'Added', [`custom-${gifted.id}`]: 'Ravi' }) })).status).toBe(302);
    expect(await customOf(addedId)).toEqual({ [gifted.id]: 'Ravi' });
  });

  it('the item page lists set values under Fields, a tick as Yes, and nothing when none are set', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const { gifted, signed, bought } = await threeFields();
    const b = await book(asha, { custom: JSON.stringify({ [gifted.id]: 'Priya', [signed.id]: true, [bought.id]: '2026-01-02' }) });
    const page = await html(ravi, `/items/${b.id}`);
    expect(page).toMatch(/custom-props[\s\S]*Fields[\s\S]*<dt>Gifted by<\/dt>\s*<dd>Priya<\/dd>[\s\S]*<dt>Signed<\/dt>\s*<dd>Yes<\/dd>[\s\S]*<dt>Bought on<\/dt>\s*<dd class="mono">2026-01-02<\/dd>/);
    const empty = await book(asha, { title: 'Empty' });
    expect(await html(ravi, `/items/${empty.id}`)).not.toContain('custom-props');
    // a value under a key no field has — a field deleted since, in an old snapshot — is never shown
    await updateItem(env.DB, empty.id, { custom: '{"999":"ghost"}' });
    expect(await html(ravi, `/items/${empty.id}`)).not.toContain('ghost');
  });
});

// ---------- privacy ----------

describe('share pages', () => {
  it('serve identical bytes with and without a private field’s value; a switched-on field shows by name on the item page only', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha, { title: 'Piranesi' });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Our books', libraryId: b.libraryId });
    const fetchBoth = async () => {
      clearSharePageCache();
      return [await (await as(null, `/share/${share.token}`)).text(), await (await as(null, `/share/${share.token}/items/${b.id}`)).text()];
    };
    const [listBefore, itemBefore] = await fetchBoth();
    expect(itemBefore).toContain('Piranesi');

    const gifted = await field('Gifted by', 'text');
    const signed = await field('Signed', 'bool');
    await updateItem(env.DB, b.id, { custom: JSON.stringify({ [gifted.id]: 'SENTINEL-PRIYA', [signed.id]: true }) });
    const [listPrivate, itemPrivate] = await fetchBoth();
    expect(listPrivate).toBe(listBefore);
    expect(itemPrivate).toBe(itemBefore);

    // the switch on for one field: that one by name on the item page, nothing else changes
    expect((await as(asha, `/settings/custom-fields/${signed.id}`, { body: { name: 'Signed', onShares: '1' } })).status).toBe(302);
    const [listOn, itemOn] = await fetchBoth();
    expect(listOn).toBe(listBefore);
    expect(itemOn).toMatch(/Fields[\s\S]*<dt>Signed<\/dt>\s*<dd>Yes<\/dd>/);
    expect(itemOn).not.toContain('SENTINEL-PRIYA');
    expect(itemOn).not.toContain('Gifted by');
    expect(itemOn).not.toContain(`"${signed.id}"`); // never the raw column or an id
    // the feed is the whitelist in another shape: never a value
    for (const kind of ['feed.atom', 'feed.rss']) {
      const feed = await (await as(null, `/share/${share.token}/${kind}`)).text();
      expect(feed).toContain('Piranesi');
      expect(feed).not.toMatch(/SENTINEL-PRIYA|Signed/);
    }
    // off again: as before
    expect((await as(asha, `/settings/custom-fields/${signed.id}`, { body: { name: 'Signed' } })).status).toBe(302);
    expect((await fetchBoth())[1]).toBe(itemBefore);
    // negative control: the app's own page shows both
    expect(await html(asha, `/items/${b.id}`)).toMatch(/Gifted by[\s\S]*SENTINEL-PRIYA[\s\S]*Signed[\s\S]*Yes/);
  });

  it('toPublicItem adds the key only for fields switched on and only when given the fields; gift lists never', async () => {
    const asha = await member('asha', 'admin');
    const gifted = await field('Gifted by', 'text');
    const signed = await field('Signed', 'bool', true);
    const item = await book(asha, { custom: JSON.stringify({ [gifted.id]: 'Priya', [signed.id]: true }) });
    const fields = await listCustomFields(env.DB);
    expect(toPublicItem(item)).not.toHaveProperty('custom');
    expect(toPublicItem(item, { customFields: [gifted] })).not.toHaveProperty('custom');
    expect(toPublicItem(item, { customFields: fields }).custom).toEqual([{ name: 'Signed', kind: 'bool', value: true }]);
    expect(JSON.stringify(toPublicItem(item, { customFields: fields }))).not.toContain('Priya');
    expect(publicCustom(item.custom, fields.map((f) => ({ ...f, onShares: true })))).toHaveLength(2); // the switch decides, nothing else
    expect(toGiftItem(item, [])).not.toHaveProperty('custom');
    // a Not owned item's fields show as any item's: the switch is the field's, not the holding's
    expect(toPublicItem({ ...item, copies: 0 }, { customFields: fields }).custom).toHaveLength(1);
  });
});

describe('connections', () => {
  let a: ReturnType<typeof instanceA>;
  let peer: Awaited<ReturnType<typeof makePeer>>;
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

  it('never get a field’s name or value — switched on or not — on the shelf, the item page, the feed or a recommendation', async () => {
    const asha = await member('asha', 'admin');
    const gifted = await field('Gifted by', 'text', true);
    const signed = await field('Signed', 'bool', true);
    // rated and reviewed, so the feed has entries about it — and so had a chance to leak
    const item: Item = await book(asha, { title: 'Piranesi', rating: 8, review: 'Luminous.', custom: JSON.stringify({ [gifted.id]: 'SENTINEL-PRIYA', [signed.id]: true }) });
    for (const out of [toConnectionItem(item), toItemDetail(item, true, [], 'a'.repeat(16)), toRecommendedItem(item, 'a'.repeat(16), viewId)]) {
      expect(out).not.toHaveProperty('custom');
      expect(JSON.stringify(out)).not.toMatch(/SENTINEL-PRIYA|Gifted by|Signed/);
    }
    const served = [
      await (await a.signedGet(`/federation/item?view=${viewId}&id=${item.id}`, peer)).text(),
      await (await a.signedGet(`/federation/shelf?view=${viewId}`, peer)).text(),
      await (await a.signedGet(`/federation/feed?view=${viewId}&since=0`, peer)).text(),
    ];
    expect(JSON.parse(served[0]!).title).toBe('Piranesi'); // answered with the item, so the fields had a chance to leak
    for (const body of served) {
      expect(body).toContain('Piranesi');
      expect(body).not.toMatch(/SENTINEL-PRIYA|Gifted by|Signed|"custom"/);
    }
    // negative control: the share whitelist, given the fields, does carry them — the connection one dropped them
    expect(toPublicItem(item, { customFields: await listCustomFields(env.DB) }).custom).toHaveLength(2);
  });
});

// ---------- the CSV ----------

describe('the CSV', () => {
  it('exports values by name in a custom column just before details, and a Nalanda import reads them back by name — a comma in a name, and a field missing here', async () => {
    const asha = await member('asha', 'admin');
    expect(EXPORT_COLUMNS.indexOf('custom')).toBe(EXPORT_COLUMNS.indexOf('details') - 1);
    const gifted = await field('Gifted by, with love', 'text');
    const signed = await field('Signed', 'bool');
    const bought = await field('Bought on', 'date');
    const b = await book(asha, { title: 'Piranesi', custom: JSON.stringify({ [gifted.id]: 'Ravi', [signed.id]: true, [bought.id]: '2026-01-02' }) });
    const plain = await book(asha, { title: 'Plain', libraryId: b.libraryId });
    const exported = await (await as(asha, '/export.csv')).text();
    const lines = parseCsv(exported);
    const line = lines.find((l) => l['title'] === 'Piranesi')!;
    expect(JSON.parse(line['custom']!)).toEqual({ 'Gifted by, with love': 'Ravi', Signed: true, 'Bought on': '2026-01-02' });
    expect(line['details']).toBe('');
    expect(lines.find((l) => l['title'] === 'Plain')!['custom']).toBe('');

    // into a household that has two of the three fields — Bought on deleted, Signed differently cased — the preview says so
    await deleteCustomField(env.DB, bought.id);
    expect((await as(asha, `/settings/custom-fields/${signed.id}`, { body: { name: 'signed' } })).status).toBe(302);
    const preview = (await as(asha, '/api/import', { json: { libraryId: b.libraryId, rows: lines, dryRun: true } })) as Response;
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ format: 'nalanda', mapped: 2, customValues: 2, customDropped: 1, customUnfit: 0 });
    const imported = await as(asha, '/api/import', { json: { libraryId: b.libraryId, rows: lines } });
    expect(await imported.json()).toMatchObject({ inserted: 2 });
    const copies = await rows<{ title: string; custom: string }>('SELECT title, custom FROM items WHERE id > ?1 ORDER BY id', plain.id);
    expect(copies.map((c) => [c.title, JSON.parse(c.custom)])).toEqual([
      ['Piranesi', { [gifted.id]: 'Ravi', [signed.id]: true }],
      ['Plain', {}],
    ]);
    // and nothing of it in details, which is the only other place a cell could land
    expect(copies.length).toBe(2);
    expect(await rows('SELECT id FROM items WHERE details LIKE ?1', '%Gifted%')).toEqual([]);
  });

  it('keeps a custom column out of details for every other format, and reads a cell by name, case aside, dropping the rest', async () => {
    expect(PRIVATE_COLUMNS.has('custom')).toBe(true);
    const cell = '{"Signed":true,"Gifted by":"Ravi"}';
    expect(mapLibibRow({ title: 'X', custom: cell }, { defaultType: 'book', musicAsVinyl: false })!.item.details).toBe('{}');
    expect(mapGoodreadsRow({ 'Title': 'X', 'Exclusive Shelf': 'to-read', 'custom': cell })!.item.details).toBe('{}');
    expect(mapStoryGraphRow({ 'Title': 'X', 'Read Status': 'to-read', 'custom': cell })!.item.details).toBe('{}');
    expect(mapLibraryThingRow({ 'Title': 'X', 'Primary Author': 'Y', 'custom': cell })!.item.details).toBe('{}');
    // a Nalanda row with no fields here: everything dropped, nothing kept anywhere
    const none = mapNalandaRow({ title: 'X', media_type: 'book', custom: cell })!;
    expect(none.item.custom).toBe('{}');
    expect(none.item.details).toBe('{}');
    expect(none.customDropped).toBe(2);
    const fields: CustomField[] = [
      { id: 3, name: 'Signed', kind: 'bool', position: 1, onShares: false, createdAt: 'x' },
      { id: 4, name: 'Bought on', kind: 'date', position: 2, onShares: false, createdAt: 'x' },
      { id: 5, name: 'Edition', kind: 'text', position: 3, onShares: false, createdAt: 'x' },
    ];
    expect(parseCustomCell('{"signed":true,"BOUGHT ON":"2026-01-02","Edition":2,"Gifted by":"Ravi","Bought":"x"}', fields)).toEqual({
      custom: JSON.stringify({ 3: true, 4: '2026-01-02', 5: '2' }),
      kept: 3,
      dropped: 2,
      unfit: 0,
    });
    expect(parseCustomCell('{"Signed":"yes","Bought on":"last spring","Edition":"' + 'x'.repeat(501) + '"}', fields)).toMatchObject({ custom: '{}', kept: 0, unfit: 3 });
    expect(parseCustomCell('{"Signed":false}', fields)).toMatchObject({ custom: '{}', kept: 0, dropped: 0, unfit: 0 }); // false is unset
    expect(parseCustomCell('not json', fields)).toMatchObject({ custom: '{}', unfit: 1 });
    expect(parseCustomCell('', fields)).toEqual({ custom: '{}', kept: 0, dropped: 0, unfit: 0 });
    expect(formatCustomCell(JSON.stringify({ 3: true, 999: 'ghost' }), fields)).toBe('{"Signed":true}'); // a key with no field is never written
    expect(formatCustomCell('{}', fields)).toBe('');
  });
});

describe('a value by its kind', () => {
  it('reads what fits, leaves blanks unset, and names the field in a refusal', () => {
    const text = { name: 'Gifted by', kind: 'text' as const };
    const bool = { name: 'Signed', kind: 'bool' as const };
    const date = { name: 'Bought on', kind: 'date' as const };
    expect(checkCustomValue(text, '  Ravi  Menon ')).toEqual({ value: 'Ravi Menon', problem: null });
    expect(checkCustomValue(text, 2)).toEqual({ value: '2', problem: null });
    expect(checkCustomValue(text, '')).toEqual({ value: null, problem: null });
    expect(checkCustomValue(text, 'x'.repeat(501)).problem).toBe('Gifted by holds at most 500 characters.');
    expect(checkCustomValue(text, { a: 1 }).problem).toBe('Gifted by must be text.');
    for (const yes of [true, '1', 'on', 'true']) expect(checkCustomValue(bool, yes)).toEqual({ value: true, problem: null });
    for (const no of [false, '', '0', 'false', undefined, null]) expect(checkCustomValue(bool, no)).toEqual({ value: null, problem: null });
    expect(checkCustomValue(bool, 'yes').problem).toBe('Signed is a yes/no field.');
    expect(checkCustomValue(date, '2026-01-02')).toEqual({ value: '2026-01-02', problem: null });
    expect(checkCustomValue(date, '2026-02-30').problem).toBe('Bought on must be a date, as 2026-10-01.');
    expect(checkCustomValue(date, '').value).toBeNull();
    // a name: one line, control characters out, at most 40
    expect(cleanCustomName('  Gifted​ by \n me ')).toBe('Gifted by me');
    expect(cleanCustomName('x'.repeat(41))).toBeNull();
    expect(cleanCustomName('​')).toBeNull();
    expect(cleanCustomName(3)).toBeNull();
    // the form: nothing without the marker, the first problem with its field, what was typed shown again
    const fields: CustomField[] = [
      { id: 1, name: 'Gifted by', kind: 'text', position: 1, onShares: false, createdAt: 'x' },
      { id: 2, name: 'Signed', kind: 'bool', position: 2, onShares: false, createdAt: 'x' },
      { id: 3, name: 'Bought on', kind: 'date', position: 3, onShares: false, createdAt: 'x' },
    ];
    expect(customFromForm({ 'custom-1': 'Ravi' }, fields)).toEqual({ values: null, shown: {}, problem: null, problemField: null });
    expect(customFromForm({ customForm: '1', 'custom-1': 'Ravi' }, [])).toEqual({ values: null, shown: {}, problem: null, problemField: null });
    expect(customFromForm({ customForm: '1', 'custom-1': ' Ravi ', 'custom-2': '1', 'custom-3': 'soon' }, fields)).toEqual({
      values: { 1: 'Ravi', 2: true },
      shown: { 1: 'Ravi', 2: true, 3: 'soon' },
      problem: 'Bought on must be a date, as 2026-10-01.',
      problemField: 3,
    });
  });
});

// ---------- the trash and history ----------

describe('the trash', () => {
  it('snapshots custom with the item and a restore brings it back', async () => {
    const asha = await member('asha', 'admin');
    const { gifted, signed } = await threeFields();
    const custom = JSON.stringify({ [gifted.id]: 'Priya', [signed.id]: true });
    const b = await book(asha, { title: 'Piranesi', custom });
    await deleteItem(env.DB, b.id, { id: asha.id, sessionKey: asha.sessionKey });
    const [row] = await listTrash(env.DB);
    const payload = JSON.parse((await getTrash(env.DB, row!.id))!.payload) as TrashPayload;
    expect((payload.item as Record<string, unknown>)['custom']).toBe(custom);
    const members = new Map((await listMembersWithKeys(env.DB)).map((m) => [m.id, m.sessionKey]));
    const restored = await restoreFromTrash(env.DB, row!.id, members);
    expect(restored).toHaveProperty('id');
    expect(await customOf((restored as { id: number }).id)).toEqual({ [gifted.id]: 'Priya', [signed.id]: true });
    expect(await html(asha, `/items/${(restored as { id: number }).id}`)).toMatch(/<dt>Gifted by<\/dt>\s*<dd>Priya<\/dd>/);
  });
});

describe('history', () => {
  it('records a custom change as "custom", before and after cut to 200, named to the writer; the page labels it Fields', async () => {
    const asha = await member('asha', 'admin');
    const { gifted } = await threeFields();
    const b = await book(asha, { title: 'Piranesi' });
    const shelf = b.libraryId;
    expect((await as(asha, `/items/${b.id}`, { body: form(shelf, { title: 'Piranesi', [`custom-${gifted.id}`]: 'Priya' }) })).status).toBe(302);
    const long = 'x'.repeat(500);
    await updateItem(env.DB, b.id, { custom: JSON.stringify({ [gifted.id]: long }) }, { id: asha.id, sessionKey: asha.sessionKey });
    const history = await rows<{ field: string; before: string | null; after: string; changed_by: number | null }>(
      "SELECT field, before, after, changed_by FROM item_history WHERE item_id = ?1 AND field = 'custom' ORDER BY id",
      b.id,
    );
    expect(history).toEqual([
      { field: 'custom', before: '{}', after: JSON.stringify({ [gifted.id]: 'Priya' }), changed_by: asha.id },
      { field: 'custom', before: JSON.stringify({ [gifted.id]: 'Priya' }), after: JSON.stringify({ [gifted.id]: long }).slice(0, 200), changed_by: asha.id },
    ]);
    // the same value again is no change
    await updateItem(env.DB, b.id, { custom: JSON.stringify({ [gifted.id]: long }) });
    expect(await rows("SELECT id FROM item_history WHERE item_id = ?1 AND field = 'custom'", b.id)).toHaveLength(2);
    expect(await html(asha, `/items/${b.id}`)).toContain('<td>Fields</td>');
  });
});

// ---------- the budget ----------

describe('D1 calls', () => {
  it('cost the item page, the shelf and the edit form nothing more with fields and values than without', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha, { title: 'Piranesi' });
    const before = { page: await calls(asha, `/items/${b.id}`), shelf: await calls(asha, `/libraries/${b.libraryId}`), form: await calls(asha, `/items/${b.id}/edit`) };
    const { gifted, signed, bought } = await threeFields();
    await updateItem(env.DB, b.id, { custom: JSON.stringify({ [gifted.id]: 'Priya', [signed.id]: true, [bought.id]: '2026-01-02' }) });
    expect(await calls(asha, `/items/${b.id}`)).toBe(before.page);
    expect(await calls(asha, `/libraries/${b.libraryId}`)).toBe(before.shelf);
    expect(await calls(asha, `/items/${b.id}/edit`)).toBe(before.form);
    expect(before.page).toBeLessThanOrEqual(12);
    expect(before.form).toBeLessThanOrEqual(12);
  });
});
