import { Hono } from 'hono';
import { activeLoanItemIds, listLibraries, searchItems } from '../db/queries';
import type { AppEnv } from '../env';
import { ItemTable } from '../views/components';
import { page } from '../views/layout';

const search = new Hono<AppEnv>();

search.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const items = q ? await searchItems(c.env.DB, q) : [];
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
      <form method="get" action="/search" role="search">
        <input type="search" name="q" value={q} placeholder="Search the catalog…" autofocus />
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
