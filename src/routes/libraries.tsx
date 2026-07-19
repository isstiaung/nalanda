import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import type { ItemStatus, MediaType, Share } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import {
  activeLoanItemIds,
  createLibrary,
  createShare,
  deleteLibrary,
  deleteShare,
  getLibrary,
  listItems,
  listShares,
  renameLibrary,
  rotateShare,
  tagsForItems,
} from '../db/queries';
import type { AppEnv } from '../env';
import { deleteCover } from '../lib/covers';
import { newShareToken } from '../lib/share';
import { ItemGrid, ItemTable, MEDIA_LABEL, Pagination, STATUS_LABEL } from '../views/components';
import { page } from '../views/layout';

/** A toolbar dropdown of any-of checkboxes — one per filter dimension. */
const FilterMenu: FC<{
  label: string;
  name: string;
  options: readonly (readonly [string, string])[];
  selected: readonly string[];
}> = ({ label, name, options, selected }) => (
  <details class="filter">
    <summary>
      {label}
      {selected.length ? <span class="filter-count">{selected.length}</span> : null}
    </summary>
    <div class="filter-menu">
      {options.map(([value, text]) => (
        <label>
          <input type="checkbox" name={name} value={value} checked={selected.includes(value)} />
          {text}
        </label>
      ))}
    </div>
  </details>
);

/** "Board games · In progress · Owned" — how a view's captured filters read. */
function shareScopeLabel(v: Share): string {
  const parts: string[] = [];
  if (v.mediaType) parts.push(MEDIA_LABEL[v.mediaType]);
  if (v.status) parts.push(STATUS_LABEL[v.status]);
  if (v.owned !== null) parts.push(v.owned ? 'Owned' : 'Not owned');
  return parts.length ? parts.join(' · ') : 'Whole shelf';
}

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

  // Filters are any-of checkbox groups, so params repeat: ?type=book&type=vinyl.
  const mediaTypes = [...new Set(c.req.queries('type') ?? [])].filter((t): t is MediaType =>
    (MEDIA_TYPES as readonly string[]).includes(t),
  );
  const statuses = [...new Set(c.req.queries('status') ?? [])].filter((st): st is ItemStatus =>
    (ITEM_STATUSES as readonly string[]).includes(st),
  );
  // Ownership is two checkboxes over one tri-state: exactly one checked filters;
  // both or neither means "owned + logged" (no filter).
  const ownedSel = [...new Set(c.req.queries('owned') ?? [])].filter((v) => v === '1' || v === '0');
  const owned = ownedSel.length === 1 ? ownedSel[0] === '1' : undefined;
  const name = (c.req.query('q') ?? '').trim() || undefined;
  const sortQ = c.req.query('sort');
  const sort = sortQ === 'title' || sortQ === 'rating' ? sortQ : 'added';
  const view = c.req.query('view') === 'grid' ? 'grid' : 'table';
  const pageNum = Number.parseInt(c.req.query('page') ?? '1', 10) || 1;

  const { items, total, page: current, pages } = await listItems(c.env.DB, id, {
    mediaTypes,
    statuses,
    owned,
    q: name,
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
    for (const t of mediaTypes) params.append('type', t);
    for (const st of statuses) params.append('status', st);
    for (const o of ownedSel) params.append('owned', o);
    if (name) params.set('q', name);
    if (sort !== 'added') params.set('sort', sort);
    if (v !== 'table') params.set('view', v);
    if (p > 1) params.set('page', String(p));
    const qs = params.toString();
    return `/libraries/${id}${qs ? `?${qs}` : ''}`;
  };

  const user = c.get('user');
  const shares = user.role === 'admin' ? await listShares(c.env.DB, id) : [];
  const origin = new URL(c.req.url).origin;

  return page(
    c,
    lib.name,
    <>
      <div class="page-head">
        <div>
          <h1>{lib.name}</h1>
          <span class="sub">
            {total} {total === 1 ? 'ITEM' : 'ITEMS'}
            {shares.length ? ' · SHARED' : ''}
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
        <input
          type="search"
          name="q"
          value={name ?? ''}
          placeholder="Title or author…"
          aria-label="Filter by name"
        />
        <FilterMenu label="Type" name="type" options={MEDIA_TYPES.map((t) => [t, MEDIA_LABEL[t]] as const)} selected={mediaTypes} />
        <FilterMenu
          label="Status"
          name="status"
          options={ITEM_STATUSES.map((st) => [st, STATUS_LABEL[st]] as const)}
          selected={statuses}
        />
        <FilterMenu
          label="Holding"
          name="owned"
          options={[
            ['1', 'Owned'],
            ['0', 'Logged — not owned'],
          ]}
          selected={ownedSel}
        />
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
            <h4>Public share links</h4>
            {shares.map((v) => (
              <div class="share-row">
                <span>
                  <strong>{v.name}</strong> <small class="muted">{shareScopeLabel(v)}</small>
                  <br />
                  <a href={`${origin}/share/${v.token}`} class="mono">
                    {origin}/share/{v.token}
                  </a>
                </span>
                <form method="post" action={`/shares/${v.id}`} class="inline-form">
                  <input type="hidden" name="libraryId" value={String(id)} />
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
              <input type="hidden" name="libraryId" value={String(id)} />
              {/* shares capture one value per filter (ARCH §9) — a multi-selection publishes as "all" */}
              {mediaTypes.length === 1 ? <input type="hidden" name="mediaType" value={mediaTypes[0]} /> : null}
              {statuses.length === 1 ? <input type="hidden" name="status" value={statuses[0]} /> : null}
              {owned !== undefined ? <input type="hidden" name="owned" value={owned ? '1' : '0'} /> : null}
              <input type="hidden" name="sort" value={sort} />
              <input name="name" placeholder="Link name (shown as the public page title)" required />
              <button type="submit" class="btn">
                Publish current view
              </button>
            </form>
            <small class="muted">
              "Current view" captures the filters applied above
              {(() => {
                const captured = [
                  mediaTypes.length === 1 ? MEDIA_LABEL[mediaTypes[0]!] : null,
                  statuses.length === 1 ? STATUS_LABEL[statuses[0]!] : null,
                  owned !== undefined ? (owned ? 'Owned' : 'Not owned') : null,
                ].filter(Boolean);
                return captured.length ? ` (${captured.join(' · ')})` : ' (none — the whole shelf)';
              })()}
              .
              {mediaTypes.length > 1 || statuses.length > 1
                ? ' Share links hold one value per filter, so a multi-selection publishes as "all".'
                : ''}{' '}
              Public pages show only whitelisted fields — never notes, loans, or copy counts.
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

libraries.post('/shares', async (c) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  const body = await c.req.parseBody();
  const str = (k: string) => {
    const v = body[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const libraryId = Number.parseInt(str('libraryId'), 10);
  const lib = Number.isInteger(libraryId) ? await getLibrary(c.env.DB, libraryId) : null;
  if (!lib) return c.text('No such shelf.', 400);
  const name = str('name') || lib.name;
  await createShare(c.env.DB, {
    token: newShareToken(),
    name,
    libraryId,
    mediaType: (MEDIA_TYPES as readonly string[]).includes(str('mediaType')) ? (str('mediaType') as MediaType) : null,
    status: (ITEM_STATUSES as readonly string[]).includes(str('status')) ? (str('status') as ItemStatus) : null,
    owned: str('owned') === '1' ? true : str('owned') === '0' ? false : null,
    sort: str('sort') === 'added' || str('sort') === 'rating' ? (str('sort') as 'added' | 'rating') : 'title',
  });
  return c.redirect(`/libraries/${libraryId}`);
});

libraries.post('/shares/:id', async (c) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const action = String(body['action'] ?? '');
  if (action === 'rotate') await rotateShare(c.env.DB, id, newShareToken());
  else if (action === 'delete') await deleteShare(c.env.DB, id);
  const back = Number.parseInt(String(body['libraryId'] ?? ''), 10);
  return c.redirect(Number.isInteger(back) ? `/libraries/${back}` : '/');
});

libraries.post('/libraries/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const coverKeys = await deleteLibrary(c.env.DB, id);
  c.executionCtx.waitUntil(Promise.all(coverKeys.map((k) => deleteCover(c.env.COVERS, k))));
  return c.redirect('/');
});

export default libraries;
