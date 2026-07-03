import { Hono } from 'hono';
import { activeLoanItemIds, itemsByTag, listTagsWithCounts } from '../db/queries';
import type { AppEnv } from '../env';
import { ItemGrid } from '../views/components';
import { page } from '../views/layout';

const tags = new Hono<AppEnv>();

tags.get('/tags', async (c) => {
  const all = await listTagsWithCounts(c.env.DB);
  return page(
    c,
    'Tags',
    <>
      <h1>Tags</h1>
      {all.length ? (
        <p class="tag-cloud">
          {all.map((t) => (
            <a href={`/tags/${encodeURIComponent(t.name)}`} class="tag">
              #{t.name} <small>({t.n})</small>
            </a>
          ))}
        </p>
      ) : (
        <p class="muted">No tags yet — add some on any item.</p>
      )}
    </>,
  );
});

tags.get('/tags/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const items = await itemsByTag(c.env.DB, name);
  const onLoanIds = await activeLoanItemIds(c.env.DB, items.map((i) => i.id));
  return page(
    c,
    `#${name}`,
    <>
      <h1>#{name}</h1>
      {items.length ? <ItemGrid items={items} onLoanIds={onLoanIds} /> : <p class="muted">No items with this tag.</p>}
    </>,
  );
});

export default tags;
