// The badges and counts the catalog sweep added (PR #89), checked by value: the Overview's recent cards' "Lent" and
// "Wanted", a series' "Wanted", and what Delete shelf says it will take with it.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, createLoan, recentItems, returnLoan, setWant } from '../src/db/queries';
import { formatCount } from '../src/lib/money';
import { book, html, member, rows } from './member-helpers';

/** Each recent card on the Overview, by item id: whether it shows the Lent and Wanted pills. */
function cardPills(page: string): Map<number, { lent: boolean; wanted: boolean }> {
  const out = new Map<number, { lent: boolean; wanted: boolean }>();
  for (const m of page.matchAll(/<a href="\/items\/(\d+)" class="item-card">([\s\S]*?)<\/a>/g)) {
    out.set(Number(m[1]), { lent: m[2]!.includes('class="pill lent"'), wanted: m[2]!.includes('class="pill wanted"') });
  }
  return out;
}

const lend = async (itemId: number) => {
  await createLoan(env.DB, { itemId, borrower: 'Anjali' });
  const [last] = await rows<{ id: number }>('SELECT max(id) AS id FROM loans');
  return last!.id;
};

describe('the Overview’s recent cards', () => {
  it('say Lent only for items with a loan still out — loan ids and item ids never lined up', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Shelf');
    const two = await book(asha, { libraryId: shelf.id, title: 'Two copies', copies: 2 }); // lent, returned, lent again
    const never = await book(asha, { libraryId: shelf.id, title: 'Never lent' });
    const out = await book(asha, { libraryId: shelf.id, title: 'Out now' });
    const back = await book(asha, { libraryId: shelf.id, title: 'Came back' });

    await returnLoan(env.DB, await lend(two.id)); // an earlier loan, returned…
    await lend(two.id); // …then out again
    // a loan whose id is also an item's id: the unqualified SQL read "loans.item_id = loans.id" and found it everywhere
    await lend(out.id);
    await returnLoan(env.DB, await lend(back.id));
    const [same] = await rows<{ n: number }>('SELECT count(*) AS n FROM loans WHERE item_id = id AND returned_on IS NULL');
    expect(same!.n).toBeGreaterThan(0); // the case that made every card say Lent

    const flags = new Map((await recentItems(env.DB, 12)).map((i) => [i.id, i.onLoan]));
    expect(flags.get(two.id)).toBe(true);
    expect(flags.get(out.id)).toBe(true);
    expect(flags.get(never.id)).toBe(false);
    expect(flags.get(back.id)).toBe(false);

    const cards = cardPills(await html(asha, '/'));
    expect(cards.get(two.id)?.lent).toBe(true);
    expect(cards.get(out.id)?.lent).toBe(true);
    expect(cards.get(never.id)?.lent).toBe(false);
    expect(cards.get(back.id)?.lent).toBe(false);
  });

  it('say Lent for a second loan of an item whose first came back, with no other loans around', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Shelf');
    const item = await book(asha, { libraryId: shelf.id, title: 'Lent twice', copies: 2 });
    await book(asha, { libraryId: shelf.id, title: 'Beside it' });
    await returnLoan(env.DB, await lend(item.id));
    const second = await lend(item.id);
    expect(second).not.toBe(item.id); // the unqualified SQL matched loans.item_id to loans.id, so this loan went unseen
    expect((await recentItems(env.DB, 12)).find((i) => i.id === item.id)?.onLoan).toBe(true);
    expect(cardPills(await html(asha, '/')).get(item.id)?.lent).toBe(true);
  });

  it('say Wanted only for a wanted item nobody owns', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Shelf');
    const wantedOwned = await book(asha, { libraryId: shelf.id, title: 'Wanted, owned', copies: 1 });
    const wantedNot = await book(asha, { libraryId: shelf.id, title: 'Wanted, not owned', copies: 0 });
    const plainNot = await book(asha, { libraryId: shelf.id, title: 'Not owned, not wanted', copies: 0 });
    await setWant(env.DB, wantedOwned.id, asha.id, true);
    await setWant(env.DB, wantedNot.id, asha.id, true);

    const flags = new Map((await recentItems(env.DB, 12)).map((i) => [i.id, i.wanted]));
    expect(flags.get(wantedNot.id)).toBe(true);
    expect(flags.get(wantedOwned.id)).toBe(false);
    expect(flags.get(plainNot.id)).toBe(false);

    const cards = cardPills(await html(asha, '/'));
    expect(cards.get(wantedNot.id)?.wanted).toBe(true);
    expect(cards.get(wantedOwned.id)?.wanted).toBe(false);
    expect(cards.get(plainNot.id)?.wanted).toBe(false);
  });
});

describe('a series’ ledger', () => {
  it('badges a wanted volume nobody owns Wanted, and no other', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Shelf');
    await env.DB.prepare("INSERT INTO series (id, name, key, total) VALUES (1, 'Earthsea', 'earthsea', 4)").run();
    const owned = await book(asha, { libraryId: shelf.id, title: 'A Wizard of Earthsea', seriesId: 1, seriesNumber: 1 });
    const wanted = await book(asha, { libraryId: shelf.id, title: 'The Tombs of Atuan', seriesId: 1, seriesNumber: 2, copies: 0 });
    const plain = await book(asha, { libraryId: shelf.id, title: 'The Farthest Shore', seriesId: 1, seriesNumber: 3, copies: 0 });
    await setWant(env.DB, wanted.id, asha.id, true);
    await setWant(env.DB, owned.id, asha.id, true); // owned: never Wanted

    const page = await html(asha, '/series/1');
    const row = (title: string) => page.match(new RegExp(`${title}</a>[\\s\\S]*?</li>`))?.[0] ?? '';
    expect(row('The Tombs of Atuan')).toContain('class="pill wanted"');
    expect(row('The Tombs of Atuan')).toContain('Not owned');
    expect(row('The Farthest Shore')).toContain('Not owned');
    expect(row('The Farthest Shore')).not.toContain('class="pill wanted"');
    expect(row('A Wizard of Earthsea')).not.toContain('class="pill wanted"');
    expect(plain.id).toBeGreaterThan(0);
  });
});

describe('Delete shelf', () => {
  const confirmOf = (page: string) => page.match(/action="\/libraries\/\d+\/delete"\s+data-confirm="([^"]*)"/)?.[1];

  it('says "the 1 item" for a shelf of one', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Single');
    await book(asha, { libraryId: shelf.id });
    expect(confirmOf(await html(asha, `/libraries/${shelf.id}`))).toBe('Delete “Single” and the 1 item in it? This cannot be undone.');
  });

  it('says the shelf is empty when it is', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Nothing here');
    expect(confirmOf(await html(asha, `/libraries/${shelf.id}`))).toBe('Delete the empty shelf “Nothing here”?');
  });

  it('counts every item on the shelf, whatever the filters show', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Mixed');
    await book(asha, { libraryId: shelf.id, title: 'Owned one' });
    await book(asha, { libraryId: shelf.id, title: 'Owned two' });
    await book(asha, { libraryId: shelf.id, title: 'Logged', copies: 0 });
    // filtered to the one not owned: the view shows 1, the shelf holds 3
    const filtered = await html(asha, `/libraries/${shelf.id}?owned=0`);
    expect(filtered).toContain('1 ITEM');
    expect(confirmOf(filtered)).toBe('Delete “Mixed” and all 3 items in it? This cannot be undone.');
  });
});

describe('counts', () => {
  it('group as prices do: 1,681 — the same Intl grouping as formatMoney', () => {
    expect(formatCount(7)).toBe('7');
    expect(formatCount(1681)).toBe('1,681');
    expect(formatCount(1_234_567)).toBe('1,234,567');
  });

  it('are monospace and grouped on the Overview', async () => {
    const asha = await member('asha', 'admin');
    await book(asha);
    const page = await html(asha, '/');
    expect(page).toContain('<div class="stat-n">1</div>'); // a stat's figure, in the mono stat style
    expect(page).toMatch(/<td class="num">1<\/td>/);
  });
});

describe('the item table at 1280px', () => {
  it('starts without Tags below 1400px until someone picks columns — before paint, from <head>', async () => {
    const asha = await member('asha', 'admin');
    const page = await html(asha, '/');
    const head = page.slice(0, page.indexOf('</head>'));
    expect(head).toContain("if(h===null&&window.matchMedia&&matchMedia('(max-width: 1399px)').matches)h='tags';");
    // a stored choice, even "show everything" (''), wins over the default
    expect(head).toContain("h=localStorage.getItem('nalanda:hidden-columns')");
  });
});

describe('games and records have no reading status', () => {
  const statusFilter = (page: string) => page.includes('<summary>Status');

  it('show no status pill in a table, on their page, or as a shelf filter — the data kept', async () => {
    const asha = await member('asha', 'admin');
    const games = await createLibrary(env.DB, 'Games');
    const game = await book(asha, { libraryId: games.id, mediaType: 'boardgame', title: 'Wingspan', status: 'completed', completedOn: '2026-05-01' });
    const record = await book(asha, { libraryId: games.id, mediaType: 'vinyl', title: 'Blue', status: 'in_progress', beganOn: '2026-09-01' });

    const shelf = await html(asha, `/libraries/${games.id}`);
    const rowOf = (title: string) => shelf.match(new RegExp(`title="${title}"[\\s\\S]*?</tr>`))?.[0] ?? '';
    expect(rowOf('Wingspan')).not.toMatch(/class="pill (done|progress|ghost-status)?[^"]*">(Completed|In progress)/);
    expect(rowOf('Wingspan')).not.toContain('>Completed<');
    expect(rowOf('Blue')).not.toContain('>In progress<');
    expect(statusFilter(shelf)).toBe(false); // a shelf of games and records: no Status filter

    const page = await html(asha, `/items/${game.id}`);
    expect(page).not.toContain('<dt>Status</dt>');
    expect(page).not.toContain('>Completed<');
    // lent, the row stays to say so
    await createLoan(env.DB, { itemId: record.id, borrower: 'Anjali' });
    const lent = await html(asha, `/items/${record.id}`);
    expect(lent).toContain('<dt>Status</dt>');
    expect(lent).toContain('class="pill lent"');
    expect(lent).not.toContain('>In progress<');

    // the edit form picks no status or dates, and carries what's there back untouched
    const form = await html(asha, `/items/${game.id}/edit`);
    expect(form).not.toContain('<select name="status"');
    expect(form).toContain('<input type="hidden" name="status" value="completed"/>');
    expect(form).toContain('<input type="hidden" name="completedOn" value="2026-05-01"/>');
    expect(await rows('SELECT status, completed_on AS completedOn FROM items WHERE id = ?1', game.id)).toEqual([{ status: 'completed', completedOn: '2026-05-01' }]);
  });

  it('keep the Status filter on a shelf with books, and for a view already filtered by status', async () => {
    const asha = await member('asha', 'admin');
    const mixed = await createLibrary(env.DB, 'Mixed');
    await book(asha, { libraryId: mixed.id, title: 'A book' });
    await book(asha, { libraryId: mixed.id, mediaType: 'boardgame', title: 'A game' });
    expect(statusFilter(await html(asha, `/libraries/${mixed.id}`))).toBe(true);
    expect(statusFilter(await html(asha, `/libraries/${mixed.id}?type=boardgame`))).toBe(false); // the view is games only
    expect(statusFilter(await html(asha, `/libraries/${mixed.id}?type=boardgame&status=completed`))).toBe(true); // clearable
    expect(await html(asha, `/libraries/${mixed.id}`)).toContain('>Not started<'); // the book keeps its pill
  });
});

describe('an item page’s Want and Where to buy', () => {
  const wantButton = (page: string) => /class="want-toggle[^"]*"/.test(page);
  const buySection = (page: string) => page.includes('id="buy"');

  it('offers no "Want to read" on an owned book someone has finished or is reading', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Shelf');
    const finished = await book(asha, { libraryId: shelf.id, title: 'Finished', status: 'completed' });
    const reading = await book(asha, { libraryId: shelf.id, title: 'Reading', status: 'in_progress' });
    const unread = await book(asha, { libraryId: shelf.id, title: 'Unread' });
    const notOwned = await book(asha, { libraryId: shelf.id, title: 'Read, not owned', status: 'completed', copies: 0 });
    expect(wantButton(await html(ravi, `/items/${finished.id}`))).toBe(false);
    expect(wantButton(await html(ravi, `/items/${reading.id}`))).toBe(false);
    expect(wantButton(await html(ravi, `/items/${unread.id}`))).toBe(true);
    expect(wantButton(await html(ravi, `/items/${notOwned.id}`))).toBe(true);

    // a want already there stays removable, and says whose
    await setWant(env.DB, finished.id, ravi.id, true);
    const withWant = await html(ravi, `/items/${finished.id}`);
    expect(withWant).toMatch(/class="want-toggle on" aria-pressed="true"/);
    expect(await html(asha, `/items/${finished.id}`)).toContain('wanted by ravi');
  });

  it('shows Where to buy only for an item nobody owns or someone wants — its links kept either way', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Shelf');
    const owned = await book(asha, { libraryId: shelf.id, title: 'Owned' });
    const notOwned = await book(asha, { libraryId: shelf.id, title: 'Not owned', copies: 0 });
    const wanted = await book(asha, { libraryId: shelf.id, title: 'Owned, wanted' });
    await setWant(env.DB, wanted.id, asha.id, true);
    await env.DB.prepare("INSERT INTO purchase_links (item_id, label, url) VALUES (?1, 'Shop', 'https://shop.example/x')").bind(owned.id).run();

    expect(buySection(await html(asha, `/items/${owned.id}`))).toBe(false);
    expect(buySection(await html(asha, `/items/${notOwned.id}`))).toBe(true);
    expect(buySection(await html(asha, `/items/${wanted.id}`))).toBe(true);
    expect(await rows('SELECT url FROM purchase_links WHERE item_id = ?1', owned.id)).toEqual([{ url: 'https://shop.example/x' }]);
  });
});
