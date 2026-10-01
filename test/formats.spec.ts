// Formats and editions (ARCH.md §16 #75): the forms an item is held in as a set on it, the other editions'
// identifiers as "also held as" lines that find the one item on a scan, and the copy that went out on a loan.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { catalogMatches, createItem, createLibrary, createShare, deleteItem, editionsOf, existingForWant, getItem, listMembersWithKeys, listTrash, memberKeys, restoreFromTrash } from '../src/db/queries';
import { mapNalandaRow } from '../src/lib/csv';
import { cleanEdition, formatFromPhysical, formatsFromPressing, formatsOf, normalizeFormats, parseEditionsCell, parseFormatsCell } from '../src/lib/formats';
import { formatLoansCell, parseLoansCell } from '../src/lib/loans';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import { as, book, html, member, rows, type Member } from './member-helpers';

describe('the formats library', () => {
  it('keeps only the kind’s codes, each once, in the kind’s order', () => {
    expect(normalizeFormats('book', ['ebook', 'HARDCOVER', 'ebook', 'lp', ' paperback '])).toBe('hardcover,paperback,ebook');
    expect(normalizeFormats('vinyl', ['cd', 'lp', 'hardcover'])).toBe('lp,cd');
    expect(normalizeFormats('other', ['anything'])).toBe('');
    expect(formatsOf({ formats: 'lp,cd' })).toEqual(['lp', 'cd']);
    expect(formatsOf({ formats: '' })).toEqual([]);
    expect(parseFormatsCell('book', 'audiobook; hardcover, nonsense')).toBe('hardcover,audiobook');
  });

  it('maps a provider’s words to a code, or none', () => {
    expect(formatFromPhysical('Paperback')).toBe('paperback');
    expect(formatFromPhysical('Mass Market Paperback')).toBe('paperback');
    expect(formatFromPhysical('Hardcover')).toBe('hardcover');
    expect(formatFromPhysical('Library Binding')).toBe('hardcover');
    expect(formatFromPhysical('Audio CD')).toBe('audiobook');
    expect(formatFromPhysical('E-book')).toBe('ebook');
    expect(formatFromPhysical('Unknown Binding')).toBeNull();
    expect(formatFromPhysical(null)).toBeNull();
    expect(formatsFromPressing('2×Vinyl, LP, Album, Reissue, 180 Gram')).toEqual(['lp']);
    expect(formatsFromPressing('CD, Album, Remastered')).toEqual(['cd']);
    expect(formatsFromPressing('Vinyl, 7", Single, 45 RPM')).toEqual(['7in']);
    expect(formatsFromPressing('Cassette, Album')).toEqual(['cassette']);
    expect(formatsFromPressing('File, FLAC, Album')).toEqual(['digital']);
    expect(formatsFromPressing('Vinyl, LP + CD, Album')).toEqual(['lp', 'cd']);
    expect(formatsFromPressing(null)).toEqual([]);
  });

  it('tidies an edition line and reads a cell back', () => {
    expect(cleanEdition('book', { format: 'Audiobook', isbn: '978-1-5266-2242-6', publisher: '  Bloomsbury  Audio ', year: '2020' })).toEqual({
      format: 'audiobook',
      isbn: '9781526622426',
      publisher: 'Bloomsbury Audio',
      year: '2020',
    });
    expect(cleanEdition('book', { format: 'lp', isbn: 'not-a-number' })).toBeNull(); // a record's code and junk: nothing left
    expect(cleanEdition('vinyl', { isbn: '0602547288462' })).toEqual({ format: null, isbn: '0602547288462', publisher: null, year: null });
    expect(cleanEdition('book', { isbn: '080442957X' })?.isbn).toBe('080442957X');
    expect(parseEditionsCell('book', '[{"format":"ebook"},{"isbn":"9781526622426","year":"2020"},"junk",{}]')).toEqual([
      { format: 'ebook', isbn: null, publisher: null, year: null },
      { format: null, isbn: '9781526622426', publisher: null, year: '2020' },
    ]);
    expect(parseEditionsCell('book', 'not json')).toEqual([]);
  });

  it('carries a loan’s copy in the loans cell', () => {
    const loans = [{ borrower: 'Priya', loanedOn: '2026-03-01', dueOn: null, returnedOn: null, contact: null, note: null, edition: 'hardcover' }];
    const cell = formatLoansCell(loans);
    expect(cell).toBe('2026-03-01..@Priya|edition:hardcover');
    expect(parseLoansCell(cell)).toEqual(loans);
    expect(parseLoansCell('2026-03-01..@Priya')[0]).not.toHaveProperty('edition'); // an older export: the key stays absent
  });
});

/** One CSV line into its cells: quoted fields, doubled quotes, commas inside quotes. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') (out.push(cur), (cur = ''));
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function household() {
  const asha = await member('asha', 'admin');
  const shelf = await createLibrary(env.DB, 'Fiction');
  return { asha, shelf };
}

/** The item form's fields for a book, with the formats and edition lines given. */
const form = (shelf: number, extra: Record<string, string>) => ({ title: 'Piranesi', libraryId: String(shelf), mediaType: 'book', ...extra });

describe('the item form', () => {
  it('adds a book held as two forms with an edition line, shows them on its page, and edits them', async () => {
    const { asha, shelf } = await household();
    const res = await as(asha, '/items', {
      body: form(shelf.id, {
        'format-hardcover': '1',
        'format-audiobook': '1',
        'format-lp': '1', // a record's code on a book: dropped
        'edition-0-format': 'audiobook',
        'edition-0-isbn': '978-1-5266-2242-6',
        'edition-0-publisher': 'Bloomsbury Audio',
        'edition-0-year': '2020',
        'edition-1-format': '',
        'edition-1-isbn': '',
      }),
    });
    expect(res.status).toBe(302);
    const id = Number(res.headers.get('location')!.match(/\/items\/(\d+)/)![1]);
    const item = (await getItem(env.DB, id))!;
    expect(item.formats).toBe('hardcover,audiobook');
    expect(await editionsOf(env.DB, id)).toEqual([{ format: 'audiobook', isbn: '9781526622426', publisher: 'Bloomsbury Audio', year: '2020' }]);

    const page = await html(asha, `/items/${id}`);
    expect(page).toContain('<span class="pill format">Hardcover</span>');
    expect(page).toContain('<span class="pill format">Audiobook</span>');
    expect(page).toContain('<dt>Also held as</dt>');
    expect(page).toContain('Audiobook, Bloomsbury Audio, 2020');
    expect(page).toContain('9781526622426');

    const edit = await html(asha, `/items/${id}/edit`);
    expect(edit).toContain('name="format-hardcover" value="1" checked');
    expect(edit).toContain('name="format-paperback" value="1"');
    expect(edit).not.toContain('name="format-paperback" value="1" checked');
    expect(edit).toContain('name="edition-0-isbn" value="9781526622426"');

    // the edit replaces both sets
    const saved = await as(asha, `/items/${id}`, { body: form(shelf.id, { 'format-paperback': '1', 'edition-0-isbn': '0802130208', 'edition-0-format': 'paperback' }) });
    expect(saved.status).toBe(302);
    expect((await getItem(env.DB, id))!.formats).toBe('paperback');
    expect(await editionsOf(env.DB, id)).toEqual([{ format: 'paperback', isbn: '0802130208', publisher: null, year: null }]);
    // a form without the lines leaves them; one with none clears them
    await as(asha, `/items/${id}`, { body: form(shelf.id, {}) });
    expect(await editionsOf(env.DB, id)).toHaveLength(1);
    await as(asha, `/items/${id}`, { body: form(shelf.id, { 'edition-0-isbn': '' }) });
    expect(await editionsOf(env.DB, id)).toEqual([]);
  });

  it('shows the lines back on a refused form', async () => {
    const { asha, shelf } = await household();
    const res = await as(asha, '/items', { body: form(shelf.id, { status: 'completed', completedOn: '2026-01-10', beganOn: '2026-02-01', 'edition-0-isbn': '9781526622426', 'format-ebook': '1' }) });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('name="edition-0-isbn" value="9781526622426"');
    expect(text).toContain('name="format-ebook" value="1" checked');
  });

  it('takes the form a provider named through the hidden field', async () => {
    const { asha, shelf } = await household();
    const res = await as(asha, '/items', { body: form(shelf.id, { formats: 'paperback' }) });
    const id = Number(res.headers.get('location')!.match(/\/items\/(\d+)/)![1]);
    expect((await getItem(env.DB, id))!.formats).toBe('paperback');
  });
});

describe('a scan of another edition', () => {
  it('finds the item by an "also held as" ISBN or barcode', async () => {
    const { asha, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi', isbn13: '9781526622426' });
    await as(asha, `/items/${b.id}`, { body: form(shelf.id, { isbn13: '9781526622426', 'edition-0-isbn': '9781526622433', 'edition-0-format': 'audiobook' }) });
    const record = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Kind of Blue', isbn10Upc: '0602547288462', details: '{}' });
    await as(asha, `/items/${record.id}`, { body: { title: 'Kind of Blue', libraryId: String(shelf.id), mediaType: 'vinyl', 'edition-0-isbn': '0888751234567', 'edition-0-format': 'cd' } });
    expect(
      await catalogMatches(env.DB, [
        { mediaType: 'book', isbn13: '9781526622433', details: {} },
        { mediaType: 'book', isbn13: '9781526622426', details: {} },
        { mediaType: 'book', isbn13: '9780000000002', details: {} },
        { mediaType: 'vinyl', isbn10Upc: '0888751234567', details: {} },
      ]),
    ).toEqual([b.id, b.id, null, record.id]);
    expect(await existingForWant(env.DB, { mediaType: 'book', isbn13: '9781526622433', details: {} })).toBe(b.id);
  });
});

describe('a loan’s copy', () => {
  it('is asked on the lend form only when the item is held in more than one form, and shown on the item and Loans pages', async () => {
    const { asha, shelf } = await household();
    const one = await book(asha, { libraryId: shelf.id, title: 'One form', formats: 'paperback' });
    expect(await html(asha, `/items/${one.id}`)).not.toContain('name="edition"');
    const two = await book(asha, { libraryId: shelf.id, title: 'Two forms', formats: 'hardcover,audiobook', copies: 2 });
    const page = await html(asha, `/items/${two.id}`);
    expect(page).toContain('<select name="edition" aria-label="Which copy">');
    await as(asha, `/items/${two.id}/loan`, { body: { borrower: 'Priya', edition: 'audiobook' } });
    await as(asha, `/items/${two.id}/loan`, { body: { borrower: 'Ravi', edition: 'lp' } }); // not one of its forms: none
    const loans = await rows<{ borrower: string; edition: string | null }>('SELECT borrower, edition FROM loans WHERE item_id = ?1 ORDER BY id', two.id);
    expect(loans).toEqual([
      { borrower: 'Priya', edition: 'audiobook' },
      { borrower: 'Ravi', edition: null },
    ]);
    expect(await html(asha, `/items/${two.id}`)).toContain('Lent to <strong>Priya</strong> (audiobook) on');
    expect(await html(asha, '/loans')).toContain('Priya<small class="muted"> · audiobook</small>');
  });
});

describe('the CSV and the trash', () => {
  it('round-trips formats, editions and a loan’s copy', async () => {
    const { asha, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi', formats: 'hardcover,ebook' });
    await as(asha, `/items/${b.id}`, { body: form(shelf.id, { 'format-hardcover': '1', 'format-ebook': '1', 'edition-0-isbn': '9781526622433', 'edition-0-format': 'audiobook', 'edition-0-year': '2020' }) });
    await as(asha, `/items/${b.id}/loan`, { body: { borrower: 'Priya', edition: 'ebook' } });
    const csv = await (await as(asha, '/export.csv')).text();
    const header = csv.split('\n')[0]!;
    expect(header).toContain('formats');
    expect(header).toContain('editions');
    const line = csv.split('\n').find((l) => l.includes('Piranesi'))!;
    expect(line).toContain('hardcover,ebook');
    expect(line).toContain('9781526622433');
    expect(line).toContain('edition:ebook');
    // and the export's row maps back onto an item with the same formats, lines and loan copy
    const [headers, values] = [parseCsvLine(header), parseCsvLine(line)];
    const mapped = mapNalandaRow(Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))) as {
      item: { formats?: string };
      editions?: Array<{ isbn: string | null }>;
      loans?: Array<{ edition?: string | null }>;
    } | null;
    expect(mapped?.item.formats).toBe('hardcover,ebook');
    expect(mapped?.editions).toEqual([{ format: 'audiobook', isbn: '9781526622433', publisher: null, year: '2020' }]);
    expect(mapped?.loans?.[0]?.edition).toBe('ebook');
    // the trash keeps the lines and restore brings them back
    await deleteItem(env.DB, b.id, { id: asha.id, sessionKey: asha.sessionKey });
    const [row2] = await listTrash(env.DB);
    const out = await restoreFromTrash(env.DB, row2!.id, memberKeys(await listMembersWithKeys(env.DB)));
    expect('id' in out).toBe(true);
    const back = (await getItem(env.DB, (out as { id: number }).id))!;
    expect(back.formats).toBe('hardcover,ebook');
    expect(await editionsOf(env.DB, back.id)).toEqual([{ format: 'audiobook', isbn: '9781526622433', publisher: null, year: '2020' }]);
    expect(await rows('SELECT edition FROM loans WHERE item_id = ?1', back.id)).toEqual([{ edition: 'ebook' }]);
  });
});

describe('what leaves the app', () => {
  it('publishes the formats and never an edition’s identifier; the shelf filter is not a share filter', async () => {
    const { asha, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi', formats: 'hardcover,ebook' });
    await as(asha, `/items/${b.id}`, { body: form(shelf.id, { 'format-hardcover': '1', 'format-ebook': '1', 'edition-0-isbn': '9781526622433', 'edition-0-publisher': 'SECRET-PUBLISHER' }) });
    const pub = toPublicItem((await getItem(env.DB, b.id))!) as unknown as Record<string, unknown>;
    expect(pub['formats']).toEqual(['hardcover', 'ebook']);
    expect(JSON.stringify(pub)).not.toContain('9781526622433');
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Shelf', libraryId: shelf.id });
    clearSharePageCache();
    const text = await (await as(null, `/share/${token}/items/${b.id}`)).text();
    expect(text).toContain('<span class="pill format">Hardcover</span>');
    expect(text).not.toContain('9781526622433');
    expect(text).not.toContain('SECRET-PUBLISHER');
    expect(text).not.toContain('Also held as');
    // the shelf filters by format; a share link has no room for it
    const shelfPage = await html(asha, `/libraries/${shelf.id}?format=ebook`);
    expect(shelfPage).toContain('Piranesi');
    const none = await html(asha, `/libraries/${shelf.id}?format=cassette`);
    expect(none).not.toContain('>Piranesi<');
    const { shareFilters } = await import('../src/lib/share');
    expect(JSON.stringify(shareFilters({ token, name: 'Shelf', libraryId: shelf.id, mediaType: null, status: null, owned: null, tag: null, sort: 'title', id: 1, createdAt: '', wantUserId: null } as never))).not.toContain('format');
  });
});
