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
      <div class="page-head">
        <div>
          <h1>Tags</h1>
          <span class="sub">{all.length} TAGS</span>
        </div>
      </div>
      {all.length ? (
        <p class="tag-cloud">
          {all.map((t) => (
            <a href={`/tags/${encodeURIComponent(t.name)}`} class="tag">
              {t.name} · {t.n}
            </a>
          ))}
        </p>
      ) : (
        <p class="muted">No tags yet — add some on any item's edit form.</p>
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
    `Tag: ${name}`,
    <>
      <div class="page-head">
        <div>
          <h1>{name}</h1>
          <span class="sub">
            TAG · {items.length} {items.length === 1 ? 'ITEM' : 'ITEMS'}
          </span>
        </div>
      </div>
      {items.length ? <ItemGrid items={items} onLoanIds={onLoanIds} /> : <p class="muted">No items carry this tag.</p>}
    </>,
  );
});

export default tags;
