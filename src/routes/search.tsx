import { Hono } from 'hono';
import { activeLoanItemIds, listLibraries, listPeople, searchItems } from '../db/queries';
import type { AppEnv } from '../env';
import { ItemTable } from '../views/components';
import { page } from '../views/layout';
import { parseReadBy, ReadByMenu } from './libraries';

const search = new Hono<AppEnv>();

search.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const user = c.get('user');
  // "Read by", as on a shelf (§16 #43) — narrowed inside the search itself, so it still finds up to 50
  const people = await listPeople(c.env.DB);
  const reader = parseReadBy(c.req.query('readBy'), user.id, people);
  const readBy = reader ? (c.req.query('readBy') ?? '') : '';
  const items = q ? await searchItems(c.env.DB, q, 50, reader) : [];
  const [onLoanIds, libs] = await Promise.all([
    activeLoanItemIds(c.env.DB, items.map((i) => i.id)),
    items.length ? listLibraries(c.env.DB) : Promise.resolve([]),
  ]);
  const libraryNames = new Map(libs.map((l) => [l.id, l.name]));

  return page(
    c,
    q ? `Search: ${q}` : 'Search',
    <>
      <div class="page-head">
        <div>
          <h1>Search</h1>
          {q ? (
            <span class="sub">
              {items.length} {items.length === 1 ? 'RESULT' : 'RESULTS'} FOR “{q.toUpperCase()}”
            </span>
          ) : (
            <span class="sub">TITLES · CREATORS · DESCRIPTIONS · NOTES</span>
          )}
        </div>
      </div>
      <form method="get" action="/search" role="search" class={people.length > 1 ? 'search-by-reader' : undefined}>
        <input type="search" name="q" value={q} placeholder="Search the catalog…" autofocus />
        {people.length > 1 || reader ? (
          <>
            <ReadByMenu value={readBy} me={user.id} people={people} />
            {/* the form's own action: a plain submit */}
            <button type="submit">Search</button>
          </>
        ) : null}
      </form>
      {q ? (
        items.length ? (
          <ItemTable items={items} onLoanIds={onLoanIds} libraryNames={libraryNames} />
        ) : (
          <p class="muted">Nothing found for “{q}”. Search covers titles, creators, descriptions, and notes.</p>
        )
      ) : null}
    </>,
  );
});

export default search;
