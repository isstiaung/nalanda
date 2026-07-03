import { Hono } from 'hono';
import { activeLoanItemIds, searchItems } from '../db/queries';
import type { AppEnv } from '../env';
import { ItemGrid } from '../views/components';
import { page } from '../views/layout';

const search = new Hono<AppEnv>();

search.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const items = q ? await searchItems(c.env.DB, q) : [];
  const onLoanIds = await activeLoanItemIds(c.env.DB, items.map((i) => i.id));

  return page(
    c,
    q ? `Search: ${q}` : 'Search',
    <>
      <form method="get" action="/search" role="search">
        <input type="search" name="q" value={q} placeholder="Title, creator, description, notes…" autofocus />
      </form>
      {q ? (
        items.length ? (
          <>
            <p class="muted">
              {items.length} {items.length === 1 ? 'result' : 'results'}
            </p>
            <ItemGrid items={items} onLoanIds={onLoanIds} />
          </>
        ) : (
          <p class="muted">Nothing found for “{q}”.</p>
        )
      ) : null}
    </>,
  );
});

export default search;
