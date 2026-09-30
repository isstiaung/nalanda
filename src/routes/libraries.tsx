import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import type { ItemStatus, MediaType, Share } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import {
  shelfFlags,
  createLibrary,
  deleteLibrary,
  getLibrary,
  listItems,
  listLibraries,
  listPeople,
  listShares,
  renameLibrary,
  shelfTotals,
  tagsForItems,
  type ReaderFilter,
} from '../db/queries';
import type { AppEnv } from '../env';
import { deleteCover } from '../lib/covers';
import { shareVisibility, shareVisibilityLabel } from '../lib/share';
import {
  ColumnsMenu,
  ItemGrid,
  ItemTable,
  MEDIA_LABEL,
  PaidTotals,
  Pagination,
  shareScopeLabel,
  STATUS_LABEL,
} from '../views/components';
import { BulkBar, BulkNotice } from '../views/bulk';
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

/**
 * The "Read by" filter's value (ARCH.md §16 #43): `me`, `not-me`, `anyone`, or a member's id — finished by them — and
 * `now-me`, `now-anyone` or `now-<id>` — being read by them now. Anything else, or a member who isn't one, is no
 * filter. Never publishable: it isn't in ItemFilters, and a share or connection view has nowhere to hold it.
 */
export function parseReadBy(raw: string | undefined, me: number, people: Array<{ id: number }>): ReaderFilter | undefined {
  const m = /^(now-)?(me|not-me|anyone|\d{1,15})$/.exec(raw ?? '');
  if (!m) return undefined;
  const mode = m[1] ? 'reading' : m[2] === 'not-me' ? 'unfinished' : 'finished';
  if (m[1] && m[2] === 'not-me') return undefined;
  if (m[2] === 'anyone') return { readerId: null, mode };
  if (m[2] === 'me' || m[2] === 'not-me') return { readerId: me, mode };
  const id = Number(m[2]);
  return people.some((p) => p.id === id) ? { readerId: id, mode } : undefined;
}

/** The Read by select — shown once the household has more than one member; one person's shelf is already theirs. */
export const ReadByMenu: FC<{ value: string; me: number; people: Array<{ id: number; username: string }> }> = ({ value, me, people }) => {
  const others = people.filter((p) => p.id !== me);
  const option = (v: string, text: string) => (
    <option value={v} selected={value === v}>
      {text}
    </option>
  );
  return (
    <select name="readBy" aria-label="Read by">
      {option('', 'Read by…')}
      <optgroup label="Finished by">
        {option('me', 'Read by me')}
        {option('not-me', 'Not read by me')}
        {others.map((p) => option(String(p.id), `Read by ${p.username}`))}
        {option('anyone', 'Read by anyone')}
      </optgroup>
      <optgroup label="Reading now">
        {option('now-me', 'Being read by me')}
        {others.map((p) => option(`now-${p.id}`, `Being read by ${p.username}`))}
        {option('now-anyone', 'Being read by anyone')}
      </optgroup>
    </select>
  );
};

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
  const user = c.get('user');
  const people = await listPeople(c.env.DB);
  const reader = parseReadBy(c.req.query('readBy'), user.id, people);
  const readBy = reader ? (c.req.query('readBy') ?? '') : '';
  const sortQ = c.req.query('sort');
  const sort = sortQ === 'title' || sortQ === 'rating' || sortQ === 'completed' ? sortQ : 'added';
  const view = c.req.query('view') === 'grid' ? 'grid' : 'table';
  const pageNum = Number.parseInt(c.req.query('page') ?? '1', 10) || 1;

  // No filter at all, and nothing found: the shelf itself is empty, and the filters have nothing to work on.
  const filtered = mediaTypes.length > 0 || statuses.length > 0 || owned !== undefined || name !== undefined || !!reader;
  const { items, total, page: current, pages } = await listItems(
    c.env.DB,
    id,
    {
      mediaTypes,
      statuses,
      owned,
      q: name,
      sort,
      page: pageNum,
    },
    reader,
  );
  const ids = items.map((i) => i.id);
  const [{ onLoan: onLoanIds, wanted: wantedIds }, tagsMap, shelves, totals] = await Promise.all([
    shelfFlags(c.env.DB, ids), // loans and the "Wanted" badge (§16 #53), one call
    view === 'table' ? tagsForItems(c.env.DB, ids) : Promise.resolve(undefined),
    // bulk edit's "Move to shelf", and the shelf a move's notice links to (§16 #47)
    listLibraries(c.env.DB),
    // what the household paid for the whole shelf (§16 #61), summed in SQL, and its currency — one call
    shelfTotals(c.env.DB, id),
  ]);
  const shelfTotal = totals.shelves.get(id);
  // everything on the shelf, whatever the filters: what deleting it takes with it
  const shelfCount = shelves.find((l) => l.id === id)?.itemCount ?? total;

  const makeHref = (p: number, v = view) => {
    const params = new URLSearchParams();
    for (const t of mediaTypes) params.append('type', t);
    for (const st of statuses) params.append('status', st);
    for (const o of ownedSel) params.append('owned', o);
    if (name) params.set('q', name);
    if (readBy) params.set('readBy', readBy);
    if (sort !== 'added') params.set('sort', sort);
    if (v !== 'table') params.set('view', v);
    if (p > 1) params.set('page', String(p));
    const qs = params.toString();
    return `/libraries/${id}${qs ? `?${qs}` : ''}`;
  };

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
            {shares.length ? ` · ${shareVisibilityLabel(shareVisibility(shares)).toUpperCase()}` : ''}
          </span>
        </div>
        <div class="page-actions">
          {/* the board games here, or a view filtered to them: "What should we play tonight?" is a click away (§16 #60) */}
          {mediaTypes.includes('boardgame') || items.some((i) => i.mediaType === 'boardgame') ? (
            <a href="/play" class="btn">
              Play tonight
            </a>
          ) : null}
          <a href="/add" class="btn">
            Add items
          </a>
        </div>
      </div>

      {shelfTotal ? <PaidTotals totals={shelfTotal} household={totals.currency} /> : null}

      <BulkNotice query={c.req.query()} libraries={shelves} />

      {total === 0 && !filtered ? null : (
        <form method="get" action={`/libraries/${id}`} class="toolbar">
          {view !== 'table' ? <input type="hidden" name="view" value={view} /> : null}
          <input
            type="search"
            name="q"
            value={name ?? ''}
            placeholder="Title, author or location…"
            aria-label="Filter by title, author or location"
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
          {people.length > 1 || reader ? <ReadByMenu value={readBy} me={user.id} people={people} /> : null}
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
            <option value="completed" selected={sort === 'completed'}>
              Date completed
            </option>
          </select>
          <button type="submit" class="btn">
            Apply
          </button>
          {/* Columns and the view toggle stay together at the row's end, and wrap as one */}
          <span class="toolbar-end">
            {/* Display-only, and only meaningful in the table: its checkboxes carry no
                `name`, so they never join this GET form. "shelf" is omitted — a single
                shelf's table has no Shelf column to hide. */}
            {view === 'table' ? (
              <ColumnsMenu
                available={['type', 'year', 'completed', 'rating', 'status', 'holding', 'tags', 'acc']}
              />
            ) : null}
            <span class="view-toggle">
              <a href={makeHref(1, 'table')} class={view === 'table' ? 'active' : undefined}>
                Table
              </a>
              <a href={makeHref(1, 'grid')} class={view === 'grid' ? 'active' : undefined}>
                Covers
              </a>
            </span>
          </span>
        </form>
      )}

      {items.length ? (
        view === 'table' ? (
          <ItemTable items={items} onLoanIds={onLoanIds} wantedIds={wantedIds} tagsMap={tagsMap} selectable />
        ) : (
          <ItemGrid items={items} onLoanIds={onLoanIds} wantedIds={wantedIds} selectable />
        )
      ) : total === 0 && !filtered ? (
        <p class="muted">
          Nothing on this shelf yet — <a href="/add">add items</a> or <a href="/import">import a CSV</a>.
        </p>
      ) : (
        <p class="muted">No items match these filters.</p>
      )}
      {items.length ? (
        <BulkBar back={makeHref(current)} admin={user.role === 'admin'} libraries={shelves} currentLibrary={id} />
      ) : null}
      <Pagination page={current} pages={pages} makeHref={(p) => makeHref(p)} />

      <details>
        <summary>Shelf settings</summary>
        <form method="post" action={`/libraries/${id}`} class="inline-form">
          <input name="name" value={lib.name} aria-label="Shelf name" required />
          <button type="submit">Rename</button>
        </form>
        {user.role === 'admin' ? (
          <div class="share-panel">
            <h2 class="share-panel-head">Public share links</h2>
            {shares.map((v) => (
              <div class="share-row">
                <span>
                  <strong>{v.name}</strong> <small class="muted">{shareScopeLabel(v)}</small>
                  <br />
                  <a href={`${origin}/share/${v.token}`} class="mono break-anywhere">
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
              <input name="name" class="share-name" placeholder="Link name (shown as the public page title)" aria-label="Link name" required />
              <button type="submit">Publish current view</button>
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
                : ''}
              {/* who read what is never published (§16 #43): the form above has no field for it */}
              {reader ? ' "Read by" is never published: the link shows this view without it.' : ''}{' '}
              Public pages show only whitelisted fields — never notes, loans, or copy counts.
            </small>
          </div>
        ) : null}
        <hr />
        <form
          method="post"
          action={`/libraries/${id}/delete`}
          data-confirm={
            shelfCount
              ? `Delete “${lib.name}” and ${shelfCount === 1 ? 'the 1 item' : `all ${shelfCount} items`} in it? This cannot be undone.`
              : `Delete the empty shelf “${lib.name}”?`
          }
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

libraries.post('/libraries/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const coverKeys = await deleteLibrary(c.env.DB, id);
  c.executionCtx.waitUntil(Promise.all(coverKeys.map((k) => deleteCover(c.env.COVERS, k))));
  return c.redirect('/');
});

export default libraries;
