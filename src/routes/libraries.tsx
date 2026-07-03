import { Hono } from 'hono';
import type { ItemStatus, MediaType } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import {
  activeLoanItemIds,
  createLibrary,
  deleteLibrary,
  getLibrary,
  listItems,
  renameLibrary,
  setShareToken,
  tagsForItems,
} from '../db/queries';
import type { AppEnv } from '../env';
import { deleteCover } from '../lib/covers';
import { newShareToken } from '../lib/share';
import { ItemGrid, ItemTable, MEDIA_LABEL, Pagination, STATUS_LABEL } from '../views/components';
import { page } from '../views/layout';

const libraries = new Hono<AppEnv>();

libraries.post('/libraries', async (c) => {
  const body = await c.req.parseBody();
  const name = String(body['name'] ?? '').trim();
  if (!name) return c.redirect('/');
  const lib = await createLibrary(c.env.DB, name);
  return c.redirect(`/libraries/${lib.id}`);
});

libraries.get('/libraries/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const lib = await getLibrary(c.env.DB, id);
  if (!lib) return c.notFound();

  const q = c.req.query();
  const mediaType = (MEDIA_TYPES as readonly string[]).includes(q['type'] ?? '') ? (q['type'] as MediaType) : undefined;
  const status = (ITEM_STATUSES as readonly string[]).includes(q['status'] ?? '')
    ? (q['status'] as ItemStatus)
    : undefined;
  const sort = q['sort'] === 'title' || q['sort'] === 'rating' ? q['sort'] : 'added';
  const view = q['view'] === 'grid' ? 'grid' : 'table';
  const pageNum = Number.parseInt(q['page'] ?? '1', 10) || 1;

  const { items, total, page: current, pages } = await listItems(c.env.DB, id, {
    mediaType,
    status,
    sort,
    page: pageNum,
  });
  const ids = items.map((i) => i.id);
  const [onLoanIds, tagsMap] = await Promise.all([
    activeLoanItemIds(c.env.DB, ids),
    view === 'table' ? tagsForItems(c.env.DB, ids) : Promise.resolve(undefined),
  ]);

  const makeHref = (p: number, v = view) => {
    const params = new URLSearchParams();
    if (mediaType) params.set('type', mediaType);
    if (status) params.set('status', status);
    if (sort !== 'added') params.set('sort', sort);
    if (v !== 'table') params.set('view', v);
    if (p > 1) params.set('page', String(p));
    const qs = params.toString();
    return `/libraries/${id}${qs ? `?${qs}` : ''}`;
  };

  const user = c.get('user');
  const shareUrl = lib.shareToken ? `${new URL(c.req.url).origin}/share/${lib.shareToken}` : null;

  return page(
    c,
    lib.name,
    <>
      <div class="page-head">
        <div>
          <h1>{lib.name}</h1>
          <span class="sub">
            {total} {total === 1 ? 'ITEM' : 'ITEMS'}
            {lib.shareToken ? ' · SHARED' : ''}
          </span>
        </div>
        <div class="page-actions">
          <a href="/add" role="button">
            Add items
          </a>
        </div>
      </div>

      <form method="get" action={`/libraries/${id}`} class="toolbar">
        {view !== 'table' ? <input type="hidden" name="view" value={view} /> : null}
        <select name="type" aria-label="Type">
          <option value="">All types</option>
          {MEDIA_TYPES.map((t) => (
            <option value={t} selected={mediaType === t}>
              {MEDIA_LABEL[t]}
            </option>
          ))}
        </select>
        <select name="status" aria-label="Status">
          <option value="">Any status</option>
          {ITEM_STATUSES.map((st) => (
            <option value={st} selected={status === st}>
              {STATUS_LABEL[st]}
            </option>
          ))}
        </select>
        <select name="sort" aria-label="Sort">
          <option value="added" selected={sort === 'added'}>
            Newest first
          </option>
          <option value="title" selected={sort === 'title'}>
            Title A–Z
          </option>
          <option value="rating" selected={sort === 'rating'}>
            Highest rated
          </option>
        </select>
        <button type="submit" class="btn">
          Apply
        </button>
        <span class="spacer"></span>
        <span class="view-toggle">
          <a href={makeHref(1, 'table')} class={view === 'table' ? 'active' : undefined}>
            Table
          </a>
          <a href={makeHref(1, 'grid')} class={view === 'grid' ? 'active' : undefined}>
            Covers
          </a>
        </span>
      </form>

      {items.length ? (
        view === 'table' ? (
          <ItemTable items={items} onLoanIds={onLoanIds} tagsMap={tagsMap} />
        ) : (
          <ItemGrid items={items} onLoanIds={onLoanIds} />
        )
      ) : (
        <p class="muted">No items match these filters.</p>
      )}
      <Pagination page={current} pages={pages} makeHref={(p) => makeHref(p)} />

      <details>
        <summary>Shelf settings</summary>
        <form method="post" action={`/libraries/${id}`} class="inline-form">
          <input name="name" value={lib.name} required />
          <button type="submit" class="btn">
            Rename
          </button>
        </form>
        {user.role === 'admin' ? (
          <div class="share-panel">
            <h4>Public share link</h4>
            {shareUrl ? (
              <>
                <p>
                  <a href={shareUrl} class="mono">
                    {shareUrl}
                  </a>
                </p>
                <form method="post" action={`/libraries/${id}/share`} class="inline-form">
                  <button name="action" value="rotate" class="btn">
                    Rotate link
                  </button>
                  <button name="action" value="disable" class="btn">
                    Disable link
                  </button>
                </form>
              </>
            ) : (
              <form method="post" action={`/libraries/${id}/share`}>
                <button name="action" value="enable" class="btn">
                  Publish read-only link
                </button>
              </form>
            )}
            <small class="muted">
              Public pages show only whitelisted fields — never notes, loans, or copies.
            </small>
          </div>
        ) : null}
        <hr />
        <form
          method="post"
          action={`/libraries/${id}/delete`}
          onsubmit={`return confirm('Delete “${lib.name}” and all ${total} items in it? This cannot be undone.')`}
        >
          <button type="submit" class="btn-danger">
            Delete shelf
          </button>
        </form>
      </details>
    </>,
  );
});

libraries.post('/libraries/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const name = String(body['name'] ?? '').trim();
  if (name) await renameLibrary(c.env.DB, id, name);
  return c.redirect(`/libraries/${id}`);
});

libraries.post('/libraries/:id/share', async (c) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  const id = Number(c.req.param('id'));
  const lib = await getLibrary(c.env.DB, id);
  if (!lib) return c.notFound();
  const body = await c.req.parseBody();
  const action = String(body['action'] ?? '');
  if (action === 'enable' || action === 'rotate') {
    await setShareToken(c.env.DB, id, newShareToken());
  } else if (action === 'disable') {
    await setShareToken(c.env.DB, id, null);
  }
  return c.redirect(`/libraries/${id}`);
});

libraries.post('/libraries/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const coverKeys = await deleteLibrary(c.env.DB, id);
  c.executionCtx.waitUntil(Promise.all(coverKeys.map((k) => deleteCover(c.env.COVERS, k))));
  return c.redirect('/');
});

export default libraries;
