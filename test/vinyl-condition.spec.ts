// A record's condition (ARCH.md §16 #55): media and sleeve, graded by hand on the Goldmine scale Discogs uses,
// validated against that fixed scale, shown on the record's page and its edit form — and never anywhere outside:
// not on share pages, not to connections. It round-trips through the CSV like every user-visible field.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView } from '../src/db/federation';
import { createItem, createLibrary, createShare, getItem } from '../src/db/queries';
import type { Bindings } from '../src/env';
import type { Item, NewItem } from '../src/db/schema';
import { budgeted } from '../src/federation/budget';
import { toConnectionItem, toItemDetail } from '../src/federation/items';
import { clearSharedViewsCache } from '../src/federation/routes';
import { parseGrade } from '../src/lib/condition';
import { EXPORT_COLUMNS, itemToCsvLine, mapLibibRow, mapNalandaRow } from '../src/lib/csv';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import { connectPeer, instanceA, makeKeys, makePeer, setUpA } from './federation-helpers';
import { as, html, member, type Member } from './member-helpers';

async function record(by: Member, values: Partial<NewItem> = {}): Promise<Item> {
  return createItem(env.DB, {
    libraryId: values.libraryId ?? (await createLibrary(env.DB, 'Records')).id,
    mediaType: 'vinyl',
    title: 'Kind of Blue',
    creators: 'Miles Davis',
    details: JSON.stringify({ label: 'Columbia', catno: 'CL 1355', country: 'US', year: 1959, format: 'Vinyl, LP, Album, Mono' }),
    addedBy: by.id,
    ...values,
  });
}

/** The edit form's fields for `item`, as the form would post them back unchanged. */
function formOf(item: Item): Record<string, string> {
  return {
    libraryId: String(item.libraryId),
    mediaType: item.mediaType,
    title: item.title,
    creators: item.creators ?? '',
    details: item.details,
    status: 'not_started',
    copies: String(item.copies),
  };
}

const gradesOf = async (id: number) => {
  const item = await getItem(env.DB, id);
  return [item!.mediaCondition, item!.sleeveCondition];
};

describe('the scale', () => {
  it('reads a grade by code or by Discogs’ wording, and refuses anything else', () => {
    expect(parseGrade('VG+', 'media')).toBe('VG+');
    expect(parseGrade('vg+', 'media')).toBe('VG+');
    expect(parseGrade('Near Mint (NM or M-)', 'media')).toBe('NM');
    expect(parseGrade('M-', 'media')).toBe('NM');
    expect(parseGrade(' Very Good Plus (VG+) ', 'sleeve')).toBe('VG+');
    expect(parseGrade('Generic', 'sleeve')).toBe('Generic');
    expect(parseGrade('no cover', 'sleeve')).toBe('No Cover');
    // nothing, or Discogs' "Not Graded": no grade
    expect(parseGrade('', 'media')).toBeNull();
    expect(parseGrade('Not Graded', 'sleeve')).toBeNull();
    // off the scale
    expect(parseGrade('Excellent', 'media')).toBeUndefined();
    expect(parseGrade('VG++', 'media')).toBeUndefined();
    expect(parseGrade('Generic', 'media')).toBeUndefined(); // a disc can't be "Generic" — only a sleeve
    expect(parseGrade('No Cover', 'media')).toBeUndefined();
    expect(parseGrade(7 as unknown, 'media')).toBeUndefined();
  });
});

describe('grading on the edit form', () => {
  it('offers both grades on a record’s form, with its grades selected, and none on a book’s', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { mediaCondition: 'VG+', sleeveCondition: 'Generic' });
    const form = await html(asha, `/items/${lp.id}/edit`);
    expect(form).toContain('name="mediaCondition"');
    expect(form).toContain('name="sleeveCondition"');
    expect(form).toContain('<option value="VG+" selected="">Very Good Plus (VG+)</option>');
    expect(form).toContain('<option value="Generic" selected="">Generic</option>');
    expect(form).toContain('<option value="No Cover">No Cover</option>');
    // the media select has no sleeve-only grades
    const media = form.slice(form.indexOf('name="mediaCondition"'), form.indexOf('name="sleeveCondition"'));
    expect(media).not.toContain('Generic');

    const book = await createItem(env.DB, { libraryId: lp.libraryId, mediaType: 'book', title: 'Piranesi', details: '{}', addedBy: asha.id });
    expect(await html(asha, `/items/${book.id}/edit`)).not.toContain('mediaCondition');
  });

  it('saves grades from the form and shows them on the record’s page', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha);
    const res = await as(asha, `/items/${lp.id}`, { body: { ...formOf(lp), mediaCondition: 'VG+', sleeveCondition: 'No Cover' } });
    expect(res.status).toBe(302);
    expect(await gradesOf(lp.id)).toEqual(['VG+', 'No Cover']);

    const page = await html(asha, `/items/${lp.id}`);
    expect(page).toContain('<dt>Media grade</dt>');
    expect(page).toContain('<span class="pill grade">VG+</span><span class="muted">Very Good Plus</span>');
    expect(page).toContain('<dt>Sleeve grade</dt>');
    expect(page).toContain('<span class="pill grade">No Cover</span>');

    // blank clears: "Not graded"
    await as(asha, `/items/${lp.id}`, { body: { ...formOf(lp), mediaCondition: '', sleeveCondition: 'NM' } });
    expect(await gradesOf(lp.id)).toEqual([null, 'NM']);
    expect(await html(asha, `/items/${lp.id}`)).not.toContain('Media grade');
  });

  it('refuses a grade off the fixed scale, saving nothing', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { mediaCondition: 'G', sleeveCondition: 'G' });
    const valid = { ...formOf(lp), title: 'Renamed', mediaCondition: 'VG', sleeveCondition: 'VG' };

    for (const bad of [
      { mediaCondition: 'Excellent' },
      { mediaCondition: 'Generic' }, // sleeve-only
      { sleeveCondition: 'VG++' },
      { sleeveCondition: '<script>' },
    ]) {
      const res = await as(asha, `/items/${lp.id}`, { body: { ...valid, ...bad } });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/Choose the (media|sleeve) grade from the list/);
      const now = await getItem(env.DB, lp.id);
      expect([now!.title, now!.mediaCondition, now!.sleeveCondition]).toEqual(['Kind of Blue', 'G', 'G']); // nothing saved
    }

    // negative control: the same form with grades on the scale saves — so the refusals above were the grades'
    expect((await as(asha, `/items/${lp.id}`, { body: valid })).status).toBe(302);
    expect([(await getItem(env.DB, lp.id))!.title, ...(await gradesOf(lp.id))]).toEqual(['Renamed', 'VG', 'VG']);
  });

  it('refuses an off-scale grade when adding, too', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Records');
    const body = { libraryId: String(shelf.id), mediaType: 'vinyl', title: 'Blue', details: '{}', status: 'not_started' };
    expect((await as(asha, '/items', { body: { ...body, mediaCondition: 'Superb' } })).status).toBe(400);
    expect((await as(asha, '/items', { body: { ...body, mediaCondition: 'NM', sleeveCondition: 'VG+' } })).status).toBe(302);
    const [added] = (await env.DB.prepare("SELECT media_condition AS m, sleeve_condition AS s FROM items WHERE title = 'Blue'").all()).results;
    expect(added).toEqual({ m: 'NM', s: 'VG+' });
  });

  it('leaves grades alone when a form sends none, and drops them when a record becomes something else', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { mediaCondition: 'M', sleeveCondition: 'NM' });
    await as(asha, `/items/${lp.id}`, { body: { ...formOf(lp), title: 'Kind of Blue (Mono)' } }); // no grade fields at all
    expect(await gradesOf(lp.id)).toEqual(['M', 'NM']);

    await as(asha, `/items/${lp.id}`, { body: { ...formOf(lp), mediaType: 'book', mediaCondition: 'M', sleeveCondition: 'NM' } });
    expect(await gradesOf(lp.id)).toEqual([null, null]);
  });

  it('drops them when a record becomes a book from a form that sends no grade fields (one opened before grades existed)', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { mediaCondition: 'NM', sleeveCondition: 'VG+' });
    await as(asha, `/items/${lp.id}`, { body: { ...formOf(lp), mediaType: 'book' } }); // no grade fields at all
    expect(await gradesOf(lp.id)).toEqual([null, null]);
  });
});

// ---------- never outside the app ----------

const GRADE_WORDS = /Media grade|Sleeve grade|mediaCondition|sleeveCondition|media_condition|sleeve_condition|Very Good Plus|Generic|pill grade/;

describe('grades never leave the app', () => {
  it('leaves them out of the share whitelist and the connection whitelists', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { mediaCondition: 'VG+', sleeveCondition: 'Generic' });
    for (const out of [toPublicItem(lp), toConnectionItem(lp), toItemDetail(lp, true, [], 'a'.repeat(16))]) {
      expect(Object.keys(out).filter((k) => /condition|grade/i.test(k))).toEqual([]);
      expect(JSON.stringify(out)).not.toMatch(/VG\+|Generic/);
    }
    // negative control: the item itself has them — the whitelists dropped them, they weren't missing
    expect([lp.mediaCondition, lp.sleeveCondition]).toEqual(['VG+', 'Generic']);
  });

  it('never renders them on a share page, where the pressing does show', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { mediaCondition: 'VG+', sleeveCondition: 'Generic' });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Our records', libraryId: lp.libraryId });
    clearSharePageCache();
    const res = await as(null, `/share/${share.token}/items/${lp.id}`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('CL 1355'); // the page rendered the record: its catalogue number is public
    expect(page).not.toMatch(GRADE_WORDS);
    expect(await (await as(null, `/share/${share.token}`)).text()).not.toMatch(GRADE_WORDS);

    // negative control: the app's own page for the same record shows them, so their absence above is the share's doing
    expect(await html(asha, `/items/${lp.id}`)).toMatch(/Media grade[\s\S]*Very Good Plus[\s\S]*Sleeve grade[\s\S]*Generic/);
  });

  describe('to connections', () => {
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

    it('serves shelf, item page and feed without them', async () => {
      const asha = await member('asha', 'admin');
      const lp = await record(asha, { mediaCondition: 'VG+', sleeveCondition: 'Generic', rating: 8, review: 'Round and warm.' });
      const served = [
        await (await a.signedGet(`/federation/item?view=${viewId}&id=${lp.id}`, peer)).text(),
        await (await a.signedGet(`/federation/shelf?view=${viewId}`, peer)).text(),
        await (await a.signedGet(`/federation/feed?view=${viewId}&since=0`, peer)).text(),
      ];
      // each answered with the record — so the grades had a chance to leak
      expect(JSON.parse(served[0]!).title).toBe('Kind of Blue');
      expect(JSON.parse(served[0]!).details.catno).toBe('CL 1355');
      for (const body of served) {
        expect(body).toContain('Kind of Blue');
        expect(body).not.toMatch(GRADE_WORDS);
        expect(body).not.toMatch(/VG\+/);
      }
    });
  });
});

// ---------- the CSV ----------

describe('grades in the CSV', () => {
  const parseLine = (line: string) => {
    // enough CSV for one line whose cells may be quoted
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') cells.push(cur), (cur = '');
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  };

  it('exports them in their own columns and imports them back', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { mediaCondition: 'NM', sleeveCondition: 'No Cover' });
    const exported = await as(asha, '/export.csv');
    const [header, row] = (await exported.text()).split('\r\n');
    const cols = parseLine(header!);
    const cells = parseLine(row!);
    const cell = Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
    expect([cell['media_condition'], cell['sleeve_condition']]).toEqual(['NM', 'No Cover']);

    const mapped = mapNalandaRow(cell)!;
    expect([mapped.item.mediaCondition, mapped.item.sleeveCondition]).toEqual(['NM', 'No Cover']);
    expect(mapped.item.details).not.toMatch(/condition/);

    // and through the import route into a new item
    const shelf = await createLibrary(env.DB, 'Imported');
    const res = await as(asha, '/api/import', { json: { libraryId: shelf.id, rows: [cell] } });
    expect(res.status).toBe(200);
    const back = (await env.DB.prepare('SELECT media_condition AS m, sleeve_condition AS s, details FROM items WHERE library_id = ?1').bind(shelf.id).all()).results;
    expect(back).toEqual([{ m: 'NM', s: 'No Cover', details: lp.details }]);
  });

  it('reads Discogs’ wording, drops what is off the scale, and never lets a grade into details', () => {
    const row = (media: string, sleeve: string, type = 'vinyl') => ({
      title: 'Blue',
      media_type: type,
      isbn10_upc: '',
      began_on: '',
      completed_on: '',
      added_at: '',
      details: '{}',
      media_condition: media,
      sleeve_condition: sleeve,
    });
    expect(mapNalandaRow(row('Very Good Plus (VG+)', 'Not Graded'))!.item).toMatchObject({ mediaCondition: 'VG+', sleeveCondition: null });
    const junk = mapNalandaRow(row('Excellent', 'Generic', 'vinyl'))!.item;
    expect([junk.mediaCondition, junk.sleeveCondition, junk.details]).toEqual([null, 'Generic', '{}']);
    // a book takes no grade
    expect(mapNalandaRow(row('VG+', 'VG+', 'book'))!.item).toMatchObject({ mediaCondition: null, sleeveCondition: null });

    // libib: unknown columns land in details, which share pages show — grades must not be among them
    const libib = mapLibibRow(
      { title: 'Blue', type: 'vinyl', 'Media Condition': 'Mint (M)', 'Sleeve Condition': 'Rubbish', 'Pressing Plant': 'Pallas' },
      { defaultType: 'vinyl', musicAsVinyl: true },
    )!;
    expect([libib.item.mediaCondition, libib.item.sleeveCondition]).toEqual(['M', null]);
    expect(JSON.parse(libib.item.details!)).toEqual({ pressing_plant: 'Pallas' }); // negative control: unknown columns still land
  });

  it('writes empty cells for an ungraded record, which read back as ungraded', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha);
    const cells = parseLine(itemToCsvLine(lp, 'Records', []).replace(/\r\n$/, ''));
    const cell = Object.fromEntries(EXPORT_COLUMNS.map((c, i) => [c, cells[i] ?? '']));
    expect(cells).toHaveLength(EXPORT_COLUMNS.length);
    expect([cell['copies'], cell['media_condition'], cell['sleeve_condition']]).toEqual(['1', '', '']);
    expect(mapNalandaRow(cell)!.item).toMatchObject({ mediaCondition: null, sleeveCondition: null });
  });
});

// ---------- the D1 budget ----------

describe('D1 calls', () => {
  it('cost a graded record’s page nothing more than a book’s', async () => {
    const asha = await member('asha', 'admin');
    const lp = await record(asha, { mediaCondition: 'VG+', sleeveCondition: 'VG' });
    const book = await createItem(env.DB, { libraryId: lp.libraryId, mediaType: 'book', title: 'Piranesi', details: '{}', addedBy: asha.id });
    const count = async (path: string) => {
      const budget = { left: 1000 };
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`http://nalanda.test${path}`, { headers: { cookie: asha.cookie } }),
        { ...env, DB: budgeted(env.DB, budget) },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      return 1000 - budget.left;
    };
    const recordPage = await count(`/items/${lp.id}`);
    const bookPage = await count(`/items/${book.id}`);
    expect(recordPage).toBe(bookPage); // grades are columns on the item's row: no query of their own
    expect(recordPage).toBeLessThanOrEqual(12);
    const recordForm = await count(`/items/${lp.id}/edit`);
    expect(recordForm).toBe(await count(`/items/${book.id}/edit`));
    expect(recordForm).toBeLessThanOrEqual(12);
  });
});
