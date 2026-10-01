// Author A–Z (ARCH.md §16 #83): a shelf sorted by the first creator's surname, worked out in SQL by splitCreators()'s
// rule — "Last, First" is one person under their last name; otherwise the first person's last word — then the full
// name, then the title; nobody named last. On the shelf, and through a share link published with that sort.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary, createShare, listItems } from '../src/db/queries';
import type { NewItem } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import app from '../src/index';
import { newShareToken } from '../src/lib/share';
import { as, html, member } from './member-helpers';

async function shelf() {
  const lib = await createLibrary(env.DB, 'Books');
  const item = (values: Partial<NewItem>) => createItem(env.DB, { libraryId: lib.id, mediaType: 'book', details: '{}', title: 'x', ...values });
  return { lib, item };
}

describe('Author A–Z', () => {
  it('orders by the first creator’s surname, then their name, then the title; nobody named last', async () => {
    const { lib, item } = await shelf();
    // seeded out of order on purpose
    await item({ title: 'Good Omens', creators: 'Terry Pratchett, Neil Gaiman' }); // two people: pratchett
    await item({ title: 'The Fifth Season', creators: 'N. K. Jemisin' }); // initials: jemisin
    await item({ title: 'Anonymous pamphlet', creators: null }); // nobody named: last
    await item({ title: 'The Dispossessed', creators: 'Ursula K. Le Guin' }); // last word: guin
    await item({ title: 'Earthsea', creators: 'Le Guin, Ursula K.' }); // one person, Last, First: le guin
    await item({ title: 'Mort', creators: 'Pratchett & Gaiman' }); // ampersand: pratchett
    await item({ title: 'A Wizard of Earthsea', creators: 'Ursula K. Le Guin' }); // guin, then the title
    await item({ title: 'Ammonite', creators: 'Nicola Griffith' }); // griffith
    await item({ title: 'Blank name', creators: '   ' }); // nobody named: last too
    await item({ title: 'Why We Can’t Wait', creators: 'Martin Luther King Jr.' }); // a suffix without a comma: king
    await item({ title: 'Stride Toward Freedom', creators: 'Martin Luther King, Jr.' }); // with one: still king, not a "Last, First"
    await item({ title: 'A Mediator', creators: 'Ralph Bunche II' }); // bunche
    const { items } = await listItems(env.DB, lib.id, { sort: 'author' });
    expect(items.map((i) => i.title)).toEqual([
      'A Mediator', // bunche
      'Ammonite', // griffith
      'A Wizard of Earthsea', // guin, "Ursula K. Le Guin", then by title
      'The Dispossessed', // guin, same name, later title
      'The Fifth Season', // jemisin
      'Why We Can’t Wait', // king — "martin luther king jr." before "martin luther king, jr." by the full string (space before comma)
      'Stride Toward Freedom',
      'Earthsea', // le guin — the "Last, First" person sorts under the whole last name
      'Mort', // pratchett, then by the full string: "pratchett & gaiman" before "terry pratchett, neil gaiman"
      'Good Omens', // pratchett — "Terry Pratchett, Neil Gaiman" is two people, the first of them
      'Anonymous pamphlet', // nobody named, last
      'Blank name',
    ]);
  });

  it('is on the shelf’s sort select and in its links, and costs the page nothing more', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    await item({ title: 'Mort', creators: 'Terry Pratchett' });
    await item({ title: 'Ammonite', creators: 'Nicola Griffith' });
    const page = await html(ravi, `/libraries/${lib.id}?sort=author`);
    expect(page).toContain('<option value="author" selected="">Author A–Z</option>');
    expect(page.indexOf('Ammonite')).toBeLessThan(page.indexOf('Mort'));
    expect(page).toContain(`href="/libraries/${lib.id}?sort=author&amp;view=grid"`);
    const calls = async (path: string) => {
      const budget = { left: 1000 };
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: { cookie: ravi.cookie } }), { ...env, DB: budgeted(env.DB, budget) } as Bindings, ctx);
      await res.text();
      await waitOnExecutionContext(ctx);
      return 1000 - budget.left;
    };
    expect(await calls(`/libraries/${lib.id}?sort=author`)).toBe(await calls(`/libraries/${lib.id}?sort=title`));
  });

  it('can be the order a share link is published in', async () => {
    const { lib, item } = await shelf();
    const admin = await member('admin', 'admin');
    await item({ title: 'Mort', creators: 'Terry Pratchett' });
    await item({ title: 'Ammonite', creators: 'Nicola Griffith' });
    const published = await as(admin, '/shares', { body: { libraryId: String(lib.id), name: 'By author', sort: 'author' } });
    expect(published.status).toBe(302);
    const token = (await html(admin, '/shares')).match(/\/share\/([A-Za-z0-9_-]{16,})/)?.[1];
    expect(token).toBeTruthy();
    const page = await (await as(null, `/share/${token}`)).text();
    expect(page.indexOf('Ammonite')).toBeLessThan(page.indexOf('Mort'));
    // and straight from the query layer, as a share made by hand
    await createShare(env.DB, { token: newShareToken(), name: 'Also by author', libraryId: lib.id, sort: 'author' });
  });
});
