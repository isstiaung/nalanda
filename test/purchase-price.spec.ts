// What the household paid (ARCH.md §16 #61): an optional purchase price on every item — books, games, records, every
// type — in integer minor units with its ISO 4217 code, entered in the household's currency, which an admin sets. It
// is entered on the add and edit forms, shown on the item page, totalled per shelf and per currency (never added
// across currencies) in SQL, and round-trips through /export.csv and the importers. It stays in the app: never on a
// share page, never to a connection, never a key of toPublicItem or toConnectionItem — and a libib file's `price`,
// which lands in details, is stripped from everything published.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView } from '../src/db/federation';
import { createLibrary, createShare, getItem, getSiteSettings, shelfTotals, updateSiteSettings } from '../src/db/queries';
import { MEDIA_TYPES } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { toConnectionItem, toFeedItem } from '../src/federation/items';
import { clearSharedViewsCache } from '../src/federation/routes';
import { EXPORT_COLUMNS, mapGoodreadsRow, mapLibibRow, mapNalandaRow } from '../src/lib/csv';
import { cellPrice, currencyDigits, formatMoney, MAX_MAJOR_UNITS, minorToDecimal, parseMoney, withoutMoney } from '../src/lib/money';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, setUpA, type Peer } from './federation-helpers';
import { as, book, html, member, rows, type Member } from './member-helpers';

const idFrom = (res: Response) => Number(res.headers.get('location')!.match(/\/items\/(\d+)/)![1]);
const setPrice = (id: number, minor: number | null, currency: string | null) =>
  // straight to the columns: updated_at stays put, so pages served before and after can be compared byte for byte
  env.DB.prepare('UPDATE items SET purchase_price = ?1, purchase_currency = ?2 WHERE id = ?3').bind(minor, currency, id).run();
const priceOf = async (id: number) => {
  const item = (await getItem(env.DB, id))!;
  return { minor: item.purchasePrice, currency: item.purchaseCurrency };
};
const form = (shelf: number, values: Record<string, string>) => ({ title: 'Piranesi', libraryId: String(shelf), mediaType: 'book', ...values });

/** How many D1 calls a signed-in GET makes — a batch is one (§16 #37). */
async function calls(who: Member, path: string): Promise<number> {
  const budget = { left: 1000 };
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, { headers: { cookie: who.cookie } }),
    { ...env, DB: budgeted(env.DB, budget) } as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status, path).toBe(200);
  await res.text();
  return 1000 - budget.left;
}

/** RFC 4180, as public/import.js parses it in the browser. */
function parseCsv(text: string): Record<string, string>[] {
  const out: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) out.push([...row, field]);
  const [header, ...body] = out;
  return body.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ''])));
}

// ---------- the arithmetic ----------

describe('money: parsing and formatting', () => {
  it('reads a price as typed into minor units, exactly, by the currency’s own decimals', () => {
    expect(parseMoney('499', 'INR')).toEqual({ ok: true, minor: 49900 });
    expect(parseMoney('38,500', 'INR')).toEqual({ ok: true, minor: 3850000 });
    expect(parseMoney(' 302.5 ', 'INR')).toEqual({ ok: true, minor: 30250 });
    expect(parseMoney('0.10', 'USD')).toEqual({ ok: true, minor: 10 });
    expect(parseMoney('0.29', 'USD')).toEqual({ ok: true, minor: 29 }); // 0.29 * 100 is 28.999999999999996 as a float
    expect(parseMoney('12.500', 'USD')).toEqual({ ok: true, minor: 1250 }); // trailing zeros are no extra precision
    expect(parseMoney('3000', 'JPY')).toEqual({ ok: true, minor: 3000 }); // a yen is its own minor unit
    expect(parseMoney('1.234', 'KWD')).toEqual({ ok: true, minor: 1234 }); // three decimals
    expect(parseMoney('0', 'INR')).toEqual({ ok: true, minor: 0 }); // a gift is a price
    expect(parseMoney('', 'INR')).toEqual({ ok: true, minor: null });
    expect(parseMoney('   ', 'INR')).toEqual({ ok: true, minor: null });
    expect(parseMoney(String(MAX_MAJOR_UNITS), 'INR')).toEqual({ ok: true, minor: MAX_MAJOR_UNITS * 100 });
    expect([currencyDigits('INR'), currencyDigits('USD'), currencyDigits('JPY'), currencyDigits('KWD')]).toEqual([2, 2, 0, 3]);
  });

  it('takes Indian grouping as well as Western — a lakh, ten lakh, a crore — and never a decimal comma', () => {
    expect(parseMoney('1,00,000', 'INR')).toEqual({ ok: true, minor: 10000000 });
    expect(parseMoney('10,00,000', 'INR')).toEqual({ ok: true, minor: 100000000 });
    expect(parseMoney('1,00,00,000', 'INR')).toEqual({ ok: true, minor: 1000000000 });
    expect(parseMoney('1,00,000.50', 'INR')).toEqual({ ok: true, minor: 10000050 });
    expect(parseMoney('38,500', 'INR')).toEqual({ ok: true, minor: 3850000 });
    expect(parseMoney('100000.50', 'INR')).toEqual({ ok: true, minor: 10000050 });
    expect(parseMoney('1,000,000', 'INR')).toEqual({ ok: true, minor: 100000000 });
    for (const bad of ['1,0,000', '12,50', '1,00,00', '10,0000', '1,00,000,00', ',100', '100,'])
      expect(parseMoney(bad, 'INR'), bad).toEqual({ ok: false, problem: 'Enter the price as a number in INR, like 499 or 12.50.' });
  });

  it('refuses a negative, anything not a number, more decimals than the currency has, and too much', () => {
    const problem = (raw: string, currency = 'INR') => {
      const r = parseMoney(raw, currency);
      return r.ok ? null : r.problem;
    };
    for (const neg of ['-5', '−5', '-0.01']) expect(problem(neg), neg).toBe('A purchase price can’t be negative.');
    for (const junk of ['abc', '1e3', '12,34', '1.2.3', '$12', '₹499', '12.', '.5', 'NaN', 'Infinity', '0x10', '1,000,00'])
      expect(problem(junk), junk).toBe('Enter the price as a number in INR, like 499 or 12.50.');
    expect(problem('12.345', 'USD')).toBe('USD takes at most 2 decimal places.');
    expect(problem('1.2345', 'KWD')).toBe('KWD takes at most 3 decimal places.');
    expect(problem('3000.5', 'JPY')).toBe('JPY has no smaller unit: enter a whole number.');
    expect(problem(String(MAX_MAJOR_UNITS + 1))).toBe('That’s more than 999,999,999 INR — check the number.');
    expect(problem('99999999999999999999999')).toBe('That’s more than 999,999,999 INR — check the number.');
  });

  it('writes minor units back as a plain decimal, and formats them exactly — a total of any size', () => {
    expect(minorToDecimal(30250, 'INR')).toBe('302.50');
    expect(minorToDecimal(5, 'USD')).toBe('0.05');
    expect(minorToDecimal(0, 'USD')).toBe('0.00');
    expect(minorToDecimal(3000, 'JPY')).toBe('3000');
    expect(minorToDecimal(1234, 'KWD')).toBe('1.234');
    expect(() => minorToDecimal(-1, 'USD')).toThrow();
    expect(() => minorToDecimal(1.5, 'USD')).toThrow();
    expect(formatMoney(3020000, 'INR')).toBe('₹30,200');
    expect(formatMoney(30250, 'INR')).toBe('₹302.50');
    expect(formatMoney(10000000, 'INR')).toBe('₹100,000'); // 'en' grouping for every currency: a lakh isn't ₹1,00,000
    expect(formatMoney(4500, 'USD')).toBe('$45');
    expect(formatMoney(3000, 'JPY')).toBe('¥3,000');
    // SQL hands a sum over as text; past 2^53 a float would have lost the last digits
    expect(formatMoney('123456789012345678901', 'USD')).toBe('$1,234,567,890,123,456,789.01');
  });

  it('strips money keys from details, whatever their case', () => {
    expect(withoutMoney({ series: 'Earthsea', price: '12.99', Price: '1', PURCHASE_PRICE: '2', purchase_currency: 'INR' })).toEqual({ series: 'Earthsea' });
  });
});

// ---------- the household's currency ----------

describe('the household currency', () => {
  it('is none until an admin sets it on the Members page, and changes but never clears', async () => {
    const asha = await member('asha', 'admin');
    expect((await getSiteSettings(env.DB)).currency).toBeNull();
    const page = await html(asha, '/settings/users');
    expect(page).toContain('<label for="household-currency">Purchase prices are entered in</label>');
    expect(page).toContain('<option value="" selected="">Choose a currency…</option>');
    expect(page).toContain('<option value="INR">INR — Indian Rupee</option>');

    const saved = await as(asha, '/settings/currency', { body: { currency: 'INR' } });
    expect(saved.status).toBe(302);
    expect(saved.headers.get('location')).toBe('/settings/users#currency');
    expect((await getSiteSettings(env.DB)).currency).toBe('INR');
    const after = await html(asha, '/settings/users');
    expect(after).toContain('<option value="INR" selected="">INR — Indian Rupee</option>');
    expect(after).not.toContain('Choose a currency…'); // set once, it can be changed, not cleared

    await as(asha, '/settings/currency', { body: { currency: 'JPY' } });
    expect((await getSiteSettings(env.DB)).currency).toBe('JPY');
  });

  it('is an admin’s: a member can neither see nor set it', async () => {
    await member('asha', 'admin');
    const ravi = await member('ravi');
    expect((await as(ravi, '/settings/users')).status).toBe(403);
    const res = await as(ravi, '/settings/currency', { body: { currency: 'USD' } });
    expect(res.status).toBe(403);
    expect((await getSiteSettings(env.DB)).currency).toBeNull();
    // and signed out, it's the login page
    expect((await as(null, '/settings/currency', { body: { currency: 'USD' } })).status).toBe(302);
    expect((await getSiteSettings(env.DB)).currency).toBeNull();
  });

  it('refuses anything that isn’t a known ISO 4217 code, with a fixed message that never repeats what was sent', async () => {
    const asha = await member('asha', 'admin');
    await updateSiteSettings(env.DB, { currency: 'INR' });
    for (const bad of ['XYZ', 'inr', 'INRR', '', '<script>alert(1)</script>', 'US$']) {
      const res = await as(asha, '/settings/currency', { body: { currency: bad } });
      expect(res.status, bad).toBe(400);
      const body = await res.text();
      expect(body).toContain('<p class="field-error" id="currency-error">Choose a currency from the list.</p>');
      expect(body).toContain('aria-describedby="currency-error currency-help"');
      if (bad) expect(body, bad).not.toContain(bad === 'inr' ? 'value="inr"' : bad);
    }
    expect((await getSiteSettings(env.DB)).currency).toBe('INR');
  });
});

// ---------- the forms ----------

describe('purchase price: adding and editing', () => {
  it('is entered on the add form and the edit form for every media type, and shown on the item page', async () => {
    const asha = await member('asha', 'admin');
    await updateSiteSettings(env.DB, { currency: 'INR' });
    const shelf = await createLibrary(env.DB, 'Everything');
    const add = await html(asha, '/add');
    expect(add).toContain('<label for="purchase-price">Purchase price <small>(what you paid, in INR — never on share pages)</small></label>');
    expect(add).toContain('<span class="money-code" aria-hidden="true">INR</span><input type="hidden" name="purchaseCurrency" value="INR"/>');
    expect(add).toContain('id="purchase-price" name="purchasePrice" value="" inputmode="decimal"');

    for (const [i, mediaType] of MEDIA_TYPES.entries()) {
      const res = await as(asha, '/items', { body: form(shelf.id, { title: `Thing ${i}`, mediaType, purchasePrice: `1,20${i}.5`, purchaseCurrency: 'INR' }) });
      expect(res.status, mediaType).toBe(302);
      const id = idFrom(res);
      expect(await priceOf(id), mediaType).toEqual({ minor: 120050 + i * 100, currency: 'INR' });
      expect(await html(asha, `/items/${id}`), mediaType).toContain(`<dt>Paid</dt><dd><span class="money">₹1,20${i}.50</span></dd>`);
      // the edit form shows it back as typed-in decimals, and changes it
      expect(await html(asha, `/items/${id}/edit`), mediaType).toContain(`name="purchasePrice" value="120${i}.50"`);
      const edited = await as(asha, `/items/${id}`, { body: form(shelf.id, { title: `Thing ${i}`, mediaType, purchasePrice: '999', purchaseCurrency: 'INR' }) });
      expect(edited.status, mediaType).toBe(302);
      expect(await priceOf(id), mediaType).toEqual({ minor: 99900, currency: 'INR' });
    }
  });

  it('is cleared by a blank field, and left alone by a form without the field', async () => {
    const asha = await member('asha', 'admin');
    await updateSiteSettings(env.DB, { currency: 'INR' });
    const shelf = await createLibrary(env.DB, 'Books');
    const id = idFrom(await as(asha, '/items', { body: form(shelf.id, { purchasePrice: '499', purchaseCurrency: 'INR' }) }));
    // a form opened before prices existed sends no price at all: nothing to change
    await as(asha, `/items/${id}`, { body: form(shelf.id, { notes: 'x' }) });
    expect(await priceOf(id)).toEqual({ minor: 49900, currency: 'INR' });
    await as(asha, `/items/${id}`, { body: form(shelf.id, { purchasePrice: '  ', purchaseCurrency: 'INR' }) });
    expect(await priceOf(id)).toEqual({ minor: null, currency: null });
    expect(await html(asha, `/items/${id}`)).not.toContain('<dt>Paid</dt>');
  });

  it('refuses a bad price with the reason tied to the field, and gives back what was typed', async () => {
    const asha = await member('asha', 'admin');
    await updateSiteSettings(env.DB, { currency: 'INR' });
    const shelf = await createLibrary(env.DB, 'Books');
    const id = idFrom(await as(asha, '/items', { body: form(shelf.id, { purchasePrice: '499', purchaseCurrency: 'INR' }) }));
    const cases: Array<[string, string]> = [
      ['-20', 'A purchase price can’t be negative.'],
      ['twelve', 'Enter the price as a number in INR, like 499 or 12.50.'],
      ['12.345', 'INR takes at most 2 decimal places.'],
      ['1000000000', 'That’s more than 999,999,999 INR — check the number.'],
    ];
    for (const [typed, reason] of cases) {
      for (const [path, label] of [['/items', 'add'], [`/items/${id}`, 'edit']] as const) {
        const res = await as(asha, path, { body: form(shelf.id, { purchasePrice: typed, purchaseCurrency: 'INR' }) });
        expect(res.status, `${label} ${typed}`).toBe(400);
        const body = await res.text();
        expect(body, `${label} ${typed}`).toContain(`<p class="field-error" id="purchase-price-error">${reason}</p>`);
        expect(body, `${label} ${typed}`).toContain(`value="${typed}" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-invalid="true" aria-describedby="purchase-price-error"`);
      }
    }
    // nothing was written: the item keeps its price, and no item was added
    expect(await priceOf(id)).toEqual({ minor: 49900, currency: 'INR' });
    expect(await rows('SELECT id FROM items')).toHaveLength(1);
  });

  it('takes a yen as a whole number: decimals are by the currency', async () => {
    const asha = await member('asha', 'admin');
    await updateSiteSettings(env.DB, { currency: 'JPY' });
    const shelf = await createLibrary(env.DB, 'Records');
    expect(await html(asha, '/add')).toContain('placeholder="0"');
    const refused = await as(asha, '/items', { body: form(shelf.id, { mediaType: 'vinyl', purchasePrice: '3000.5', purchaseCurrency: 'JPY' }) });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('JPY has no smaller unit: enter a whole number.');
    const id = idFrom(await as(asha, '/items', { body: form(shelf.id, { mediaType: 'vinyl', purchasePrice: '3,000', purchaseCurrency: 'JPY' }) }));
    expect(await priceOf(id)).toEqual({ minor: 3000, currency: 'JPY' });
    expect(await html(asha, `/items/${id}`)).toContain('<span class="money">¥3,000</span>');
  });

  it('asks for a household currency before any price: no field, and a post with one is refused', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Books');
    const adminForm = await html(asha, '/add');
    expect(adminForm).not.toContain('name="purchasePrice"');
    expect(adminForm).toContain('<a href="/settings/users#currency">set the household currency</a> first');
    expect(await html(ravi, '/add')).toContain('an admin sets the household currency first, under Members');
    const res = await as(asha, '/items', { body: form(shelf.id, { purchasePrice: '499' }) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Set the household currency first: prices are entered in it.');
    expect(await rows('SELECT id FROM items')).toEqual([]);
    // blank is fine: there's nothing to be in a currency
    expect((await as(asha, '/items', { body: form(shelf.id, { purchasePrice: '' }) })).status).toBe(302);
  });

  it('keeps a price in the currency it was entered in when the household changes currency, and offers the new one', async () => {
    const asha = await member('asha', 'admin');
    await updateSiteSettings(env.DB, { currency: 'USD' });
    const shelf = await createLibrary(env.DB, 'Records');
    const id = idFrom(await as(asha, '/items', { body: form(shelf.id, { mediaType: 'vinyl', purchasePrice: '45', purchaseCurrency: 'USD' }) }));
    await as(asha, '/settings/currency', { body: { currency: 'INR' } });
    expect(await priceOf(id)).toEqual({ minor: 4500, currency: 'USD' }); // nothing converted

    const edit = await html(asha, `/items/${id}/edit`);
    expect(edit).toContain('<select name="purchaseCurrency" aria-label="Currency it was paid in"><option value="USD" selected="">USD</option><option value="INR">INR</option></select>');
    expect(edit).toContain('aria-describedby="purchase-price-note"');
    expect(edit).toContain('Entered in USD before the household&#39;s currency became INR.');
    // saved as it is, it stays in dollars
    await as(asha, `/items/${id}`, { body: form(shelf.id, { mediaType: 'vinyl', purchasePrice: '45.00', purchaseCurrency: 'USD' }) });
    expect(await priceOf(id)).toEqual({ minor: 4500, currency: 'USD' });
    // a currency the form never offered is refused, not stored
    const crafted = await as(asha, `/items/${id}`, { body: form(shelf.id, { mediaType: 'vinyl', purchasePrice: '45', purchaseCurrency: 'EUR' }) });
    expect(crafted.status).toBe(400);
    expect(await crafted.text()).toContain('Enter the price in INR.');
    expect(await priceOf(id)).toEqual({ minor: 4500, currency: 'USD' });
    // re-entered in the household's currency
    await as(asha, `/items/${id}`, { body: form(shelf.id, { mediaType: 'vinyl', purchasePrice: '3,800', purchaseCurrency: 'INR' }) });
    expect(await priceOf(id)).toEqual({ minor: 380000, currency: 'INR' });
    expect(await html(asha, `/items/${id}/edit`)).not.toContain('<select name="purchaseCurrency"');
    // and a new item can only be in the household's
    const other = await as(asha, '/items', { body: form(shelf.id, { purchasePrice: '10', purchaseCurrency: 'USD' }) });
    expect(other.status).toBe(400);
  });

  it('shows the price field in the household currency on a refused add from a form that had none', async () => {
    const asha = await member('asha', 'admin');
    await updateSiteSettings(env.DB, { currency: 'INR' });
    const shelf = await createLibrary(env.DB, 'Books');
    // refused for its reading dates, sent without the price field (a result card's form, say)
    const res = await as(asha, '/items', { body: form(shelf.id, { status: 'not_started', beganOn: '2026-01-01' }) });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('what you paid, in INR');
    expect(body).not.toContain('set the household currency');
  });

  it('is any member’s to set, like the location', async () => {
    await member('asha', 'admin');
    const ravi = await member('ravi');
    await updateSiteSettings(env.DB, { currency: 'INR' });
    const shelf = await createLibrary(env.DB, 'Games');
    const id = idFrom(await as(ravi, '/items', { body: form(shelf.id, { mediaType: 'boardgame', title: 'Catan', purchasePrice: '2499', purchaseCurrency: 'INR' }) }));
    expect(await priceOf(id)).toEqual({ minor: 249900, currency: 'INR' });
  });
});

// ---------- CSV ----------

describe('purchase price: CSV', () => {
  const exportRow = (values: Record<string, string>) => ({ title: 'T', media_type: 'book', isbn10_upc: '', began_on: '', completed_on: '', added_at: '', details: '', ...values });

  it('leaves in two columns after the loans — a plain decimal and its code — and comes back through /api/import', async () => {
    const asha = await member('asha', 'admin');
    const from = await createLibrary(env.DB, 'From');
    const priced = [
      await book(asha, { libraryId: from.id, title: 'Rupees', purchasePrice: 3850050, purchaseCurrency: 'INR' }),
      await book(asha, { libraryId: from.id, title: 'Dollars', mediaType: 'vinyl', purchasePrice: 5, purchaseCurrency: 'USD' }),
      await book(asha, { libraryId: from.id, title: 'Yen', mediaType: 'boardgame', purchasePrice: 3000, purchaseCurrency: 'JPY' }),
      await book(asha, { libraryId: from.id, title: 'Gift', purchasePrice: 0, purchaseCurrency: 'INR' }),
      await book(asha, { libraryId: from.id, title: 'Unpriced' }),
    ];
    expect(EXPORT_COLUMNS.indexOf('purchase_price')).toBe(EXPORT_COLUMNS.indexOf('loans') + 1);
    expect(EXPORT_COLUMNS.indexOf('purchase_currency')).toBe(EXPORT_COLUMNS.indexOf('purchase_price') + 1);
    const csv = await html(asha, '/export.csv');
    const parsed = parseCsv(csv);
    expect(parsed.map((r) => [r['title'], r['purchase_price'], r['purchase_currency']])).toEqual([
      ['Rupees', '38500.50', 'INR'],
      ['Dollars', '0.05', 'USD'],
      ['Yen', '3000', 'JPY'],
      ['Gift', '0.00', 'INR'],
      ['Unpriced', '', ''],
    ]);

    // back in, onto another shelf, in a household whose currency is something else again: each keeps its own
    await updateSiteSettings(env.DB, { currency: 'GBP' });
    const to = await createLibrary(env.DB, 'To');
    const preview = await as(asha, '/api/import', { json: { libraryId: to.id, rows: parsed, dryRun: true } });
    expect(await preview.json()).toMatchObject({ format: 'nalanda', prices: 4, currency: 'GBP', pricesLeft: 0 });
    expect(await (await as(asha, '/api/import', { json: { libraryId: to.id, rows: parsed } })).json()).toMatchObject({ inserted: 5 });
    const back = await rows<{ title: string; p: number | null; c: string | null }>(
      'SELECT title, purchase_price AS p, purchase_currency AS c FROM items WHERE library_id = ?1 ORDER BY id',
      to.id,
    );
    expect(back).toEqual(priced.map((i) => ({ title: i.title, p: i.purchasePrice ?? null, c: i.purchaseCurrency ?? null })));
    // and nothing about money fell into details
    for (const r of await rows<{ details: string }>('SELECT details FROM items WHERE library_id = ?1', to.id)) {
      expect(r.details).not.toMatch(/price|currency/);
    }
  });

  it('reads a row’s price in the currency it names, or the household’s when it names none — and never guesses', () => {
    const price = (values: Record<string, string>, household: string | null = null) => {
      const item = mapNalandaRow(exportRow(values), household)!.item;
      return [item.purchasePrice, item.purchaseCurrency];
    };
    expect(price({ purchase_price: '302.50', purchase_currency: 'INR' })).toEqual([30250, 'INR']);
    expect(price({ purchase_price: '302.50', purchase_currency: 'inr' })).toEqual([30250, 'INR']);
    expect(price({ purchase_price: '302.50', purchase_currency: '' }, 'EUR')).toEqual([30250, 'EUR']);
    expect(price({ purchase_price: '302.50', purchase_currency: '' })).toEqual([null, null]); // no currency to be in
    expect(price({ purchase_price: '302.50', purchase_currency: 'XYZ' }, 'INR')).toEqual([null, null]); // not a currency
    expect(price({ purchase_price: '-3', purchase_currency: 'INR' })).toEqual([null, null]);
    expect(price({ purchase_price: '3.505', purchase_currency: 'INR' })).toEqual([null, null]);
    expect(price({ purchase_price: '3.5', purchase_currency: 'JPY' })).toEqual([null, null]);
    expect(price({ purchase_price: 'abc', purchase_currency: 'INR' })).toEqual([null, null]);
    expect(price({ purchase_price: '', purchase_currency: 'INR' })).toEqual([null, null]);
    expect(price({})).toEqual([null, null]); // an export from before prices
    expect(cellPrice('1e9', 'USD', null)).toBeNull();
  });

  it('maps libib’s price in the household’s currency — kept in details, which publish no money, when it can’t be', () => {
    const libib = (row: Record<string, string>, currency: string | null) => mapLibibRow(row, { defaultType: 'book', musicAsVinyl: true, currency })!.item;
    const mapped = libib({ title: 'Dune', Price: '12.99', ensemble: 'kept' }, 'USD');
    expect([mapped.purchasePrice, mapped.purchaseCurrency]).toEqual([1299, 'USD']);
    expect(JSON.parse(mapped.details!)).toEqual({ ensemble: 'kept' });
    // no household currency: the price can't be read as money, so it stays as libib gave it
    const none = libib({ title: 'Dune', price: '12.99' }, null);
    expect([none.purchasePrice, none.purchaseCurrency]).toEqual([null, null]);
    expect(JSON.parse(none.details!)).toEqual({ price: '12.99' });
    const symbol = libib({ title: 'Dune', price: '$12.99' }, 'USD');
    expect([symbol.purchasePrice, symbol.purchaseCurrency]).toEqual([null, null]);
    expect(JSON.parse(symbol.details!)).toEqual({ price: '$12.99' });
    // a Nalanda export missing a column reads as libib: its own price columns map, never into details
    const own = libib({ title: 'Dune', purchase_price: '500', purchase_currency: 'INR' }, 'USD');
    expect([own.purchasePrice, own.purchaseCurrency]).toEqual([50000, 'INR']);
    expect(JSON.parse(own.details!)).toEqual({});
  });

  it('never lets a Goodreads row carry price columns into details', () => {
    const m = mapGoodreadsRow({ Title: 'Dune', 'Exclusive Shelf': 'read', purchase_price: '5', purchase_currency: 'USD' })!;
    expect(m.item.details).toBe('{}');
  });

  it('says in the preview when libib prices stay in details', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Books');
    const libibRows = [{ title: 'Dune', price: '12.99' }, { title: 'Emma', price: '' }];
    expect(await (await as(asha, '/api/import', { json: { libraryId: shelf.id, rows: libibRows, dryRun: true } })).json()).toMatchObject({
      format: 'libib',
      prices: 0,
      currency: null,
      pricesLeft: 1,
    });
    await updateSiteSettings(env.DB, { currency: 'USD' });
    expect(await (await as(asha, '/api/import', { json: { libraryId: shelf.id, rows: libibRows, dryRun: true } })).json()).toMatchObject({
      prices: 1,
      currency: 'USD',
      pricesLeft: 0,
    });
  });
});

// ---------- totals ----------

describe('purchase price: totals per shelf', () => {
  it('sums each currency on its own, in SQL, and never adds across them', async () => {
    const asha = await member('asha', 'admin');
    await updateSiteSettings(env.DB, { currency: 'INR' });
    const vinyl = await createLibrary(env.DB, 'Vinyl');
    const other = await createLibrary(env.DB, 'Other');
    const record = (values: Parameters<typeof book>[1]) => book(asha, { libraryId: vinyl.id, mediaType: 'vinyl', ...values });
    await record({ title: 'A', purchasePrice: 1800000, purchaseCurrency: 'INR' });
    await record({ title: 'B', purchasePrice: 1220000, purchaseCurrency: 'INR' });
    await record({ title: 'C', purchasePrice: 4500, purchaseCurrency: 'USD' });
    await record({ title: 'D' });
    await book(asha, { libraryId: other.id, title: 'E', purchasePrice: 99, purchaseCurrency: 'INR' });

    const { shelves, currency } = await shelfTotals(env.DB, vinyl.id);
    expect(currency).toBe('INR');
    expect([...shelves.keys()]).toEqual([vinyl.id]); // one shelf's, not the other's
    const t = shelves.get(vinyl.id)!;
    expect({ items: t.items, priced: t.priced, byType: t.byType }).toEqual({ items: 4, priced: 3, byType: [{ mediaType: 'vinyl', count: 4 }] });
    expect(t.paid.sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
      { currency: 'INR', count: 2, total: '3020000' },
      { currency: 'USD', count: 1, total: '4500' },
    ]);

    const page = await html(asha, `/libraries/${vinyl.id}`);
    expect(page).toContain(
      '<p class="paid-totals"><span class="eyebrow">Paid</span> <span class="money">₹30,200</span> <span class="muted">for <span class="mono">2</span></span><span class="muted"> · </span><span class="money">$45</span> <span class="muted">for <span class="mono">1</span>, in USD</span> <span class="muted">— of <span class="mono">4</span> records on this shelf</span></p>',
    );
    // the Overview: a Paid column, each shelf's currencies side by side
    const overview = await html(asha, '/');
    expect(overview).toContain('<th class="num">Paid</th>');
    expect(overview).toContain('<td class="num money-cell">₹30,200 · $45</td>');
    expect(overview).toContain('<td class="num money-cell">₹0.99</td>');
  });

  it('is an exact integer sum, and shows nothing while nothing is priced', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Dear');
    expect(await html(asha, `/libraries/${shelf.id}`)).not.toContain('paid-totals');
    expect(await html(asha, '/')).not.toContain('<th class="num">Paid</th>');
    // 20 items near the cap: 1,999,999,998,020 paise, which leaves SQL as the text of an integer sum — a float sum
    // (total(), or an average) would come back as "…020.0" and never reach the page as money
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
       INSERT INTO items (library_id, media_type, title, details, purchase_price, purchase_currency)
       SELECT ?1, 'book', 'Dear ' || i, '{}', 99999999901, 'INR' FROM n`,
    )
      .bind(shelf.id)
      .run();
    const page = await html(asha, `/libraries/${shelf.id}`);
    expect(page).toContain('<span class="money">₹19,999,999,980.20</span> <span class="muted">for <span class="mono">20</span></span>');
    expect(page).toContain('— of <span class="mono">20</span> books on this shelf');
  });

  it('costs the shelf page one D1 call, however many items and currencies it holds', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Big');
    await book(asha, { libraryId: shelf.id });
    const before = await calls(asha, `/libraries/${shelf.id}`);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
       INSERT INTO items (library_id, media_type, title, details, purchase_price, purchase_currency)
       SELECT ?1, CASE i % 3 WHEN 0 THEN 'book' WHEN 1 THEN 'vinyl' ELSE 'boardgame' END, 'Item ' || i, '{}', i * 100,
              CASE i % 4 WHEN 0 THEN 'INR' WHEN 1 THEN 'USD' WHEN 2 THEN 'JPY' ELSE 'EUR' END FROM n`,
    )
      .bind(shelf.id)
      .run();
    const after = await calls(asha, `/libraries/${shelf.id}`);
    expect(after).toBe(before);
    // 12 before §16 #61 (measured with the totals left out): the totals' batch is one more. Then 7 since §16 #68: the
    // shelves, their counts and every shelf's totals are one batch, read once for the page and its sidebar, and they
    // name this shelf and count its unfiltered items too
    expect(after).toBe(7);
  });
});

describe('purchase price: D1 calls', () => {
  it('costs the item page nothing, and the forms and saves one call for the household currency', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Books');
    const plain = await book(asha, { libraryId: shelf.id, title: 'Plain' });
    const priced = await book(asha, { libraryId: shelf.id, title: 'Priced', purchasePrice: 49900, purchaseCurrency: 'INR' });
    await updateSiteSettings(env.DB, { currency: 'INR' });
    expect(await calls(asha, `/items/${priced.id}`)).toBe(await calls(asha, `/items/${plain.id}`));
    expect(await calls(asha, `/items/${priced.id}/edit`)).toBe(await calls(asha, `/items/${plain.id}/edit`));
  });

  it('keeps a scan’s add — no price field — at the calls it made before', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Books');
    const post = async (values: Record<string, string>) => {
      const budget = { left: 1000 };
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request('http://nalanda.test/items', {
          method: 'POST',
          headers: { cookie: asha.cookie, origin: 'http://nalanda.test', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form(shelf.id, values)).toString(),
          redirect: 'manual',
        }),
        { ...env, DB: budgeted(env.DB, budget) } as Bindings,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(302);
      return 1000 - budget.left;
    };
    await updateSiteSettings(env.DB, { currency: 'INR' });
    const withoutField = await post({});
    const withField = await post({ purchasePrice: '10', purchaseCurrency: 'INR' });
    expect(withField).toBe(withoutField + 1);
  });
});

// ---------- never published ----------

describe('purchase price: never outside the app', () => {
  it('is not a key of the share whitelist, a connection item or a feed item — nor is a libib price in details', async () => {
    const asha = await member('asha', 'admin');
    const item = await book(asha, {
      title: 'Piranesi',
      rating: 8,
      review: 'Tides',
      purchasePrice: 7777777,
      purchaseCurrency: 'INR',
      details: JSON.stringify({ price: '77777.77', ensemble: 'kept' }),
    });
    const outside = [toPublicItem(item, { progress: true, reviews: [] }), toConnectionItem(item), toFeedItem(item, 'reviewed', '0123456789abcdef')];
    for (const o of outside) {
      expect(o).not.toHaveProperty('purchasePrice');
      expect(o).not.toHaveProperty('purchaseCurrency');
      expect(JSON.stringify(o)).not.toMatch(/7777|price|INR/i);
    }
    expect(toPublicItem(item).details).toEqual({ ensemble: 'kept' });
  });

  it('never reaches a share page — listing or item — and changes no byte of one', async () => {
    const asha = await member('asha', 'admin');
    await updateSiteSettings(env.DB, { currency: 'INR', progressOnShares: true });
    const shelf = await createLibrary(env.DB, 'Records');
    const item = await book(asha, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Kind of Blue', rating: 8, review: 'Modal' });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: shelf.id });
    const pages = async () => {
      clearSharePageCache();
      return [await (await as(null, `/share/${share.token}`)).text(), await (await as(null, `/share/${share.token}/items/${item.id}`)).text()];
    };
    const without = await pages();
    await setPrice(item.id, 7777700, 'INR');
    const withIt = await pages();
    for (const p of withIt) expect(p).not.toMatch(/77,777|77777|₹|Paid/);
    expect(withIt).toEqual(without);
    expect(withIt[1]).toContain('Kind of Blue');

    // a libib price in details: in the app, and stripped from the share page
    await env.DB.prepare('UPDATE items SET details = ?1 WHERE id = ?2').bind(JSON.stringify({ price: '88888.88', ensemble: 'Quintet' }), item.id).run();
    expect(await html(asha, `/items/${item.id}`)).toContain('88888.88');
    const shared = await pages();
    for (const p of shared) expect(p).not.toContain('88888');
    expect(shared[1]).toContain('Quintet');
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

    const served = async (itemId: number) => [
      await (await a.signedGet(`/federation/shelf?view=${viewId}&page=1`, peer)).text(),
      await (await a.signedGet(`/federation/item?view=${viewId}&id=${itemId}`, peer)).text(),
      await (await a.signedGet(`/federation/feed?view=${viewId}&since=0`, peer)).text(),
    ];

    it('never reaches a connection’s shelf, item page or feed, and changes no byte of them', async () => {
      const asha = await member('asha', 'admin');
      await updateSiteSettings(env.DB, { currency: 'INR' });
      const item = await book(asha, { title: 'Piranesi', rating: 8, review: 'Tides', status: 'completed', completedOn: new Date().toISOString().slice(0, 10) });
      const without = await served(item.id);
      expect(without[1]).toContain('Piranesi');
      await setPrice(item.id, 7777700, 'INR');
      const withIt = await served(item.id);
      for (const body of withIt) expect(body).not.toMatch(/77777|purchase|INR/i);
      expect(withIt).toEqual(without);

      // nor a libib price kept in details, which a connection's item page otherwise carries as plain values
      await env.DB.prepare('UPDATE items SET details = ?1 WHERE id = ?2').bind(JSON.stringify({ price: '88888.88', ensemble: 'Quintet' }), item.id).run();
      const detail = JSON.parse(await (await a.signedGet(`/federation/item?view=${viewId}&id=${item.id}`, peer)).text());
      expect(detail.item?.details ?? detail.details).toEqual({ ensemble: 'Quintet' });
    });

    it('records no activity when only the price changes', async () => {
      const asha = await member('asha', 'admin');
      await updateSiteSettings(env.DB, { currency: 'INR' });
      const shelf = await createLibrary(env.DB, 'Fiction');
      const today = new Date().toISOString().slice(0, 10);
      const item = await book(asha, { libraryId: shelf.id, title: 'Piranesi', rating: 8, review: 'Tides', status: 'completed', completedOn: today });
      const log = async () => [await rows('SELECT * FROM activity_log ORDER BY id'), await rows('SELECT * FROM member_activity ORDER BY id')];
      const before = await log();
      expect(before[0]!.length).toBeGreaterThan(0);
      const saved = await as(asha, `/items/${item.id}`, {
        body: { title: 'Piranesi', libraryId: String(shelf.id), mediaType: 'book', status: 'completed', completedOn: today, rating: '8', review: 'Tides', purchasePrice: '499', purchaseCurrency: 'INR' },
      });
      expect(saved.status).toBe(302);
      expect(await priceOf(item.id)).toEqual({ minor: 49900, currency: 'INR' });
      expect(await log()).toEqual(before);
    });
  });
});

describe('purchase price: a row edited by hand', () => {
  it('leaves a price that isn’t whole, non-negative minor units out of the page, the totals and the export — failing none', async () => {
    const asha = await member('asha', 'admin');
    await updateSiteSettings(env.DB, { currency: 'INR' });
    const shelf = await createLibrary(env.DB, 'Odd');
    await book(asha, { libraryId: shelf.id, title: 'Good', purchasePrice: 1000, purchaseCurrency: 'INR' });
    const odd = [
      await book(asha, { libraryId: shelf.id, title: 'Fraction' }),
      await book(asha, { libraryId: shelf.id, title: 'Negative' }),
      await book(asha, { libraryId: shelf.id, title: 'No code' }),
      await book(asha, { libraryId: shelf.id, title: 'Bad code' }),
    ];
    await setPrice(odd[0]!.id, 12.5, 'INR');
    await setPrice(odd[1]!.id, -500, 'INR');
    await setPrice(odd[2]!.id, 500, null);
    await setPrice(odd[3]!.id, 500, 'rupees');
    const page = await as(asha, `/libraries/${shelf.id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<span class="money">₹10</span> <span class="muted">for <span class="mono">1</span></span>');
    // a code shaped like one that Intl doesn't know: out of the totals, as it is out of its own page and the export
    const zzz = await book(asha, { libraryId: shelf.id, title: 'Unknown code' });
    await setPrice(zzz.id, 700, 'ZZZ');
    const t = (await shelfTotals(env.DB, shelf.id)).shelves.get(shelf.id)!;
    expect(t.paid).toEqual([{ currency: 'INR', count: 1, total: '1000' }]);
    expect(t.priced).toBe(1);
    const again = await (await as(asha, `/libraries/${shelf.id}`)).text();
    expect(again).not.toContain('ZZZ');
    expect(again).toContain('<span class="money">₹10</span> <span class="muted">for <span class="mono">1</span></span> <span class="muted">— of <span class="mono">6</span> books on this shelf</span>');
    expect(await html(asha, `/items/${zzz.id}`)).not.toContain('<dt>Paid</dt>');
    await env.DB.prepare('DELETE FROM items WHERE id = ?1').bind(zzz.id).run();
    expect((await as(asha, '/')).status).toBe(200);
    for (const i of odd) {
      const itemPage = await as(asha, `/items/${i.id}`);
      expect(itemPage.status, i.title).toBe(200);
      expect(await itemPage.text(), i.title).not.toContain('<dt>Paid</dt>');
      expect((await as(asha, `/items/${i.id}/edit`)).status, i.title).toBe(200);
    }
    const exported = parseCsv(await html(asha, '/export.csv'));
    expect(exported.map((r) => [r['title'], r['purchase_price'], r['purchase_currency']])).toEqual([
      ['Good', '10.00', 'INR'],
      ['Fraction', '', ''],
      ['Negative', '', ''],
      ['No code', '', ''],
      ['Bad code', '', ''],
    ]);
  });
});
