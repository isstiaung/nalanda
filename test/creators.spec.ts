// Creators and publishers as pages (ARCH.md §16 #72): the people behind the items, read out of `creators` by the
// rule Year in review already uses, and publishers (a record's label) out of `publisher`. Signed-in only.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addPastRead, createItem, createLibrary, createShare, YEAR_CREATORS } from '../src/db/queries';
import { CREATOR_ROLE, mainType, splitCreators, type NameCount } from '../src/lib/creators';
import { newShareToken } from '../src/lib/share';
import { as, book, html, member } from './member-helpers';

describe('splitCreators', () => {
  const cases: Array<[string | null, string[]]> = [
    [null, []],
    ['', []],
    ['  Ursula K. Le Guin ', ['Ursula K. Le Guin']],
    ['Terry Pratchett, Neil Gaiman', ['Terry Pratchett', 'Neil Gaiman']],
    ['Le Guin, Ursula K.', ['Ursula K. Le Guin']],
    ['Tolkien, J. R. R.', ['J. R. R. Tolkien']],
    ['Herbert, Frank', ['Frank Herbert']],
    ['James S. A. Corey, Someone', ['James S. A. Corey', 'Someone']],
    ['Martin Luther King, Jr.', ['Martin Luther King']],
    ['Pratchett & Gaiman', ['Pratchett', 'Gaiman']],
    ['A; B; C', ['A', 'B', 'C']],
    ['Reiner Knizia, Jr., Someone', ['Reiner Knizia', 'Someone']],
    ['Miles Davis', ['Miles Davis']],
    ['Various Artists', ['Various Artists']],
    [', ,', []],
    ['Jens Østergaard, Čapek, Karel', ['Jens Østergaard', 'Čapek', 'Karel']],
    ['Ødegaard, Martin', ['Martin Ødegaard']],
    // SQLite's trim() takes spaces only: a tab or a no-break space stays part of a name, in both twins
    ['\tTab Name\t, Second Person', ['\tTab Name\t', 'Second Person']],
    ['\u00a0Nbsp Name, Second Person', ['\u00a0Nbsp Name', 'Second Person']],
  ];
  it.each(cases)('%j → %j', (input, expected) => {
    expect(splitCreators(input)).toEqual(expected);
  });

  it('agrees with YEAR_CREATORS, the SQL it twins, on every case', async () => {
    // the SQL expects a `scoped` CTE with scope, work, ended_on and creators; feed it the cases as rows, and number
    // each name as the recursion finds it (a CTE has no rowid to order by)
    const rows = await env.DB.prepare(
      `WITH scoped AS (
         SELECT 'x' AS scope, key AS work, '2026-01-01' AS ended_on, value AS creators FROM json_each(?1)
       ),
       ${YEAR_CREATORS},
       split(scope, work, ended_on, name, rest, n) AS (
         SELECT scope, work, ended_on, '', names || ',', 0 FROM people
         UNION ALL
         SELECT scope, work, ended_on, trim(substr(rest, 1, instr(rest, ',') - 1)), substr(rest, instr(rest, ',') + 1), n + 1
         FROM split WHERE rest <> ''
       )
       SELECT work, name FROM split WHERE name <> '' AND lower(name) NOT IN ('jr', 'jr.', 'sr', 'sr.') ORDER BY CAST(work AS INTEGER), n`,
    )
      .bind(JSON.stringify(cases.map(([c]) => c)))
      .all<{ work: string; name: string }>();
    const bySql = new Map<string, string[]>();
    for (const r of rows.results) bySql.set(String(r.work), [...(bySql.get(String(r.work)) ?? []), r.name]);
    cases.forEach(([input, expected], i) => {
      expect(bySql.get(String(i)) ?? []).toEqual(expected);
    });
  });
});

describe('mainType', () => {
  it('is the kind a name has most of, ties in the fixed order', () => {
    const n = (byType: NameCount['byType']): NameCount => ({ name: 'x', key: 'x', total: 0, byType });
    expect(mainType(n({ book: 2, vinyl: 5 }))).toBe('vinyl');
    expect(mainType(n({ book: 2, vinyl: 2 }))).toBe('book');
    expect(mainType(n({}))).toBe('book');
    expect(CREATOR_ROLE[mainType(n({ boardgame: 1 }))].one).toBe('Designer');
  });
});

async function household() {
  const asha = await member('asha', 'admin');
  const books = await createLibrary(env.DB, 'Fiction');
  const records = await createLibrary(env.DB, 'Records');
  const games = await createLibrary(env.DB, 'Games');
  return { asha, books, records, games };
}

const record = (libraryId: number, title: string, creators: string, publisher: string | null = null) =>
  createItem(env.DB, { libraryId, mediaType: 'vinyl', title, creators, publisher, details: '{}' });
const game = (libraryId: number, title: string, creators: string, publisher: string | null = null) =>
  createItem(env.DB, { libraryId, mediaType: 'boardgame', title, creators, publisher, details: '{}' });

describe('the Creators index', () => {
  it('groups names by what they mostly are, counts by kind, and narrows by name', async () => {
    const { asha, books, records, games } = await household();
    await book(asha, { libraryId: books.id, title: 'A Wizard of Earthsea', creators: 'Le Guin, Ursula K.' });
    await book(asha, { libraryId: books.id, title: 'The Dispossessed', creators: 'Ursula K. Le Guin' });
    await book(asha, { libraryId: books.id, title: 'Good Omens', creators: 'Terry Pratchett, Neil Gaiman' });
    await record(records.id, 'Kind of Blue', 'Miles Davis');
    await record(records.id, 'Sketches of Spain', 'miles davis'); // the first spelling seen is shown
    await game(games.id, 'Azul', 'Reiner Knizia');
    await game(games.id, 'Ra', 'Michael Kiesling');
    await book(asha, { libraryId: books.id, title: 'A Game Novel', creators: 'Michael Kiesling' }); // one of each: an author, by order

    const text = await html(asha, '/creators');
    expect(text).toContain('6 NAMES');
    const at = (s: string) => text.indexOf(s);
    expect(at('Authors')).toBeGreaterThan(0);
    expect(at('Authors')).toBeLessThan(at('Designers'));
    expect(at('Designers')).toBeLessThan(at('Artists'));
    expect(text).toContain('href="/creators/Ursula%20K.%20Le%20Guin"');
    expect(text).toContain('>2 books<');
    expect(text).toContain('href="/creators/Miles%20Davis"');
    expect(text).not.toContain('href="/creators/miles%20davis"');
    expect(text).toContain('>2 records<');
    // Kiesling has one book and one game: a tie goes to books, listed under Authors with both kinds
    expect(text).toMatch(/Michael Kiesling<\/a>\s*<span class="mono muted">1 book · 1 game</);
    expect(text).not.toContain('Michael Kiesling</a>\n          <span class="mono muted">1 game');

    const narrowed = await html(asha, '/creators?q=guin');
    expect(narrowed).toContain('1 MATCHING');
    expect(narrowed).toContain('Ursula K. Le Guin');
    expect(narrowed).not.toContain('Miles Davis');
    expect(await html(asha, '/creators?q=zzz')).toContain('Nothing matches that.');
  });

  it('says so when the catalog names nobody', async () => {
    const asha = await member('asha', 'admin');
    expect(await html(asha, '/creators')).toContain('No creators yet');
    expect(await html(asha, '/publishers')).toContain('No publishers yet');
  });
});

describe('a creator’s page', () => {
  it('lists exactly the items that name them, however the string is written, with what you have finished', async () => {
    const { asha, books, records } = await household();
    const ravi = await member('ravi');
    const wizard = await book(asha, { libraryId: books.id, title: 'A Wizard of Earthsea', creators: 'Le Guin, Ursula K.' });
    await book(asha, { libraryId: books.id, title: 'The Dispossessed', creators: 'Ursula K. Le Guin' });
    await book(asha, { libraryId: books.id, title: 'An Anthology', creators: 'Someone Else, Ursula K. Le Guin' });
    await book(asha, { libraryId: books.id, title: 'A Biography', creators: 'Ursula K. Le Guin Jr.' }); // a different person
    await book(asha, { libraryId: books.id, title: 'Unrelated', creators: 'Frank Herbert' });
    await record(records.id, 'Readings', 'Ursula K. Le Guin'); // the same name, another kind
    await addPastRead(env.DB, wizard.id, { status: 'completed', beganOn: null, endedOn: '2026-01-10' }, ravi.id);

    const text = await html(ravi, '/creators/Ursula%20K.%20Le%20Guin');
    expect(text).toContain('<h1>Ursula K. Le Guin</h1>');
    expect(text).toContain('AUTHOR · 3 BOOKS · 1 RECORD · 1 FINISHED BY YOU');
    for (const t of ['A Wizard of Earthsea', 'The Dispossessed', 'An Anthology', 'Readings']) expect(text).toContain(t);
    for (const t of ['A Biography', 'Unrelated']) expect(text).not.toContain(t);
    // the same page under either spelling and case
    expect(await html(ravi, '/creators/ursula%20k.%20le%20guin')).toContain('AUTHOR · 3 BOOKS');
    // nobody of that name: as a tag nothing carries
    expect((await as(ravi, '/creators/Nobody%20Here')).status).toBe(404);
  });

  it('finds a name whose last word has a capital SQLite’s lower() leaves alone, and names with URL characters', async () => {
    const { asha, books, records } = await household();
    await book(asha, { libraryId: books.id, title: 'Kierkegaard', creators: 'Jens Østergaard' });
    await book(asha, { libraryId: books.id, title: 'R.U.R.', creators: 'Čapek, Karel' });
    await record(records.id, 'Back in Black', 'AC/DC');
    await record(records.id, 'Odd', '100% Pure? Yes');
    for (const [name, title] of [
      ['Jens Østergaard', 'Kierkegaard'],
      ['Karel Čapek', 'R.U.R.'],
      ['AC/DC', 'Back in Black'],
      ['100% Pure? Yes', 'Odd'],
    ] as const) {
      const index = await html(asha, '/creators');
      const link = `href="/creators/${encodeURIComponent(name)}"`;
      expect(index).toContain(link);
      const text = await html(asha, `/creators/${encodeURIComponent(name)}`);
      expect(text).toContain(`<h1>${name.replace(/&/g, '&amp;')}</h1>`);
      expect(text).toContain(title);
    }
  });

  it('pages at sixty', async () => {
    const { asha, books } = await household();
    for (let i = 1; i <= 61; i++) await book(asha, { libraryId: books.id, title: `Book ${String(i).padStart(2, '0')}`, creators: 'Prolific Pen' });
    const first = await html(asha, '/creators/Prolific%20Pen');
    expect(first).toContain('Book 01');
    expect(first).not.toContain('Book 61');
    expect(first).toContain('href="/creators/Prolific%20Pen?page=2"');
    expect(await html(asha, '/creators/Prolific%20Pen?page=2')).toContain('Book 61');
  });
});

describe('publishers', () => {
  it('index and page, with a record’s label called a label', async () => {
    const { asha, books, records } = await household();
    await book(asha, { libraryId: books.id, title: 'Dune', creators: 'Frank Herbert', publisher: 'Chilton' });
    await book(asha, { libraryId: books.id, title: 'Children of Dune', creators: 'Frank Herbert', publisher: ' chilton ' });
    await record(records.id, 'Kind of Blue', 'Miles Davis', 'Columbia');
    const index = await html(asha, '/publishers');
    expect(index).toContain('2 NAMES');
    expect(index).toContain('Publishers');
    expect(index).toContain('Labels');
    expect(index).toContain('href="/publishers/Chilton"');
    expect(index).toContain('>2 books<');
    const columbia = await html(asha, '/publishers/Columbia');
    expect(columbia).toContain('LABEL · 1 RECORD');
    expect(columbia).toContain('Kind of Blue');
    const chilton = await html(asha, '/publishers/chilton');
    expect(chilton).toContain('PUBLISHER · 2 BOOKS');
    expect(chilton).not.toContain('Kind of Blue');
  });
});

describe('an item’s page', () => {
  it('links each creator and the publisher to their pages', async () => {
    const { asha, books } = await household();
    const b = await book(asha, { libraryId: books.id, title: 'Good Omens', creators: 'Terry Pratchett, Neil Gaiman', publisher: 'Gollancz' });
    const text = await html(asha, `/items/${b.id}`);
    expect(text).toContain('<a href="/creators/Terry%20Pratchett">Terry Pratchett</a>, <a href="/creators/Neil%20Gaiman">Neil Gaiman</a>');
    expect(text).toContain('<a href="/publishers/Gollancz">Gollancz</a>');
    // "Last, First" is shown as written, with the person linked after it
    const w = await book(asha, { libraryId: books.id, title: 'A Wizard of Earthsea', creators: 'Le Guin, Ursula K.' });
    const wt = await html(asha, `/items/${w.id}`);
    expect(wt).toContain('Le Guin, Ursula K.');
    expect(wt).toContain('<a href="/creators/Ursula%20K.%20Le%20Guin">Ursula K. Le Guin</a>');
  });

  it('is in the sidebar’s Library section, and not on a share page', async () => {
    const asha = await member('asha', 'admin');
    const nav = await html(asha, '/');
    expect(nav).toContain('href="/creators"');
    expect(nav).toContain('href="/publishers"');
  });
});

describe('share pages', () => {
  it('keep creators and publishers as text: no link into the app', async () => {
    const { asha, books } = await household();
    const b = await book(asha, { libraryId: books.id, title: 'Dune', creators: 'Frank Herbert', publisher: 'Chilton' });
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Shelf', libraryId: books.id });
    const text = await (await as(null, `/share/${token}/items/${b.id}`)).text();
    expect(text).toContain('Frank Herbert');
    expect(text).not.toContain('/creators/');
    expect(text).not.toContain('/publishers/');
  });
});
