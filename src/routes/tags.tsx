import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { activeLoanItemIds, itemsByTag, listTagShares, listTagsWithCounts } from '../db/queries';
import type { Share } from '../db/schema';
import type { AppEnv } from '../env';
import { ItemGrid, shareScopeLabel } from '../views/components';
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

/** Admin-only: the public links for a tag — everything carrying it, on any shelf — to publish, rotate or remove. */
const TagLinks: FC<{ tag: string; links: Share[]; origin: string }> = ({ tag, links, origin }) => (
  <section style="margin-top:2rem">
    <p class="eyebrow">Public links</p>
    {links.map((v) => (
      <div class="share-row">
        <span>
          <strong>{v.name}</strong> <small class="muted">{shareScopeLabel(v)}</small>
          <br />
          <a href={`${origin}/share/${v.token}`} class="mono">
            {origin}/share/{v.token}
          </a>
        </span>
        <form method="post" action={`/shares/${v.id}`} class="inline-form">
          <input type="hidden" name="tag" value={tag} />
          <button name="action" value="rotate" class="btn">
            Rotate
          </button>
          <button name="action" value="delete" class="btn-danger">
            Remove
          </button>
        </form>
      </div>
    ))}
    <form method="post" action="/shares" class="inline-form">
      <input type="hidden" name="tag" value={tag} />
      <input name="name" placeholder="Link name (shown as the public page title)" required />
      <select name="sort" aria-label="Order">
        <option value="title">By title</option>
        <option value="completed">By date finished</option>
        <option value="rating">By rating</option>
        <option value="added">By date added</option>
      </select>
      <button type="submit" class="btn">
        Publish this tag
      </button>
    </form>
    <small class="muted">
      A link here shows every item tagged “{tag}”, on any shelf, owned or not. Public pages show only whitelisted
      fields — never notes, loans, or copy counts.
    </small>
  </section>
);

tags.get('/tags/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const tag = name.toLowerCase();
  const admin = c.get('user').role === 'admin';
  const [items, links] = await Promise.all([
    itemsByTag(c.env.DB, name),
    admin ? listTagShares(c.env.DB, tag) : Promise.resolve([]),
  ]);
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
      {admin && (items.length || links.length) ? (
        <TagLinks tag={tag} links={links} origin={new URL(c.req.url).origin} />
      ) : null}
    </>,
  );
});

export default tags;
