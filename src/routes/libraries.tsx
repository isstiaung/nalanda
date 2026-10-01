import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import type { ItemStatus, MediaType, Share } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import {
  shelfFlags,
  createLibrary,
  deleteLibrary,
  deleteSavedView,
  listItems,
  listPeople,
  listShares,
  MAX_SAVED_VIEWS_PER_SHELF,
  MAX_VIEW_NAME,
  renameLibrary,
  saveView,
  shelvesWithTotals,
  tagsForItems,
  TRASH_DAYS,
  type ReaderFilter,
  type SavedView,
  type StaleFilter,
} from '../db/queries';
import type { AppEnv } from '../env';
import { deleteCover } from '../lib/covers';
import { formatCount } from '../lib/money';
import { isPlayable } from '../lib/plays';
import { shareVisibility } from '../lib/share';
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
import { Fill, mediaLabel, statusLabel, useI18n, visibilityLabel } from '../views/i18n';
import { page, todayOf } from '../views/layout';
import { ALL_FORMATS } from '../lib/formats';

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
  const m = READ_BY.exec(raw ?? '');
  if (!m) return undefined;
  const mode = m[1] ? 'reading' : m[2] === 'not-me' ? 'unfinished' : 'finished';
  if (m[1] && m[2] === 'not-me') return undefined;
  if (m[2] === 'anyone') return { readerId: null, mode };
  if (m[2] === 'me' || m[2] === 'not-me') return { readerId: me, mode };
  const id = Number(m[2]);
  return people.some((p) => p.id === id) ? { readerId: id, mode } : undefined;
}

/** A "Read by" value's shape: `now-` or not, then who — `me`, `not-me`, `anyone`, or a member's id. */
const READ_BY = /^(now-)?(me|not-me|anyone|\d{1,15})$/;

/**
 * A "Read by" value as the menu writes it — a member's id without leading zeros, `02` as `2` — for the bar's links and a
 * saved view; '' for one parseReadBy() would refuse. Never the value as typed: a view saved from `readBy=02` named
 * member 2 and yet escaped deleteUser()'s rewrite, which looked for `2`, so once they left it listed whoever was
 * given the id next under the old name (§16 #81, #56). Written from the value's shape, not the filter it parsed to:
 * `me` and one's own id parse alike, but a view saved as `me` is each member's own and one saved by id is one person's.
 */
export function readByValue(raw: string | undefined): string {
  const m = READ_BY.exec(raw ?? '');
  if (!m || (m[1] && m[2] === 'not-me')) return '';
  const who = /^\d/.test(m[2]!) ? String(Number(m[2])) : m[2];
  return `${m[1] ?? ''}${who}`;
}

/** The Read by select — shown once the household has more than one member; one person's shelf is already theirs. */
export const ReadByMenu: FC<{ value: string; me: number; people: Array<{ id: number; username: string }> }> = ({ value, me, people }) => {
  const { t } = useI18n();
  const others = people.filter((p) => p.id !== me);
  const option = (v: string, text: string) => (
    <option value={v} selected={value === v}>
      {text}
    </option>
  );
  return (
    <select name="readBy" aria-label={t('readby.label')}>
      {option('', t('readby.any'))}
      <optgroup label={t('readby.finished_by')}>
        {option('me', t('readby.me'))}
        {option('not-me', t('readby.not_me'))}
        {others.map((p) => option(String(p.id), t('readby.person', { name: p.username })))}
        {option('anyone', t('readby.anyone'))}
      </optgroup>
      <optgroup label={t('readby.reading_now')}>
        {option('now-me', t('readby.now_me'))}
        {others.map((p) => option(`now-${p.id}`, t('readby.now_person', { name: p.username })))}
        {option('now-anyone', t('readby.now_anyone'))}
      </optgroup>
    </select>
  );
};

/** What a shelf's filter bar says (ARCH.md §16 #81): the URL's query, or a saved view's stored one, read the same way. */
export type ShelfQuery = {
  mediaTypes: MediaType[];
  statuses: ItemStatus[];
  ownedSel: string[]; // the Holding checkboxes: '1' owned, '0' not owned, 'b' borrowed from someone (§16 #82)
  owned: boolean | undefined;
  holding: StaleFilter['holding']; // the Holding filter once Borrowed is among its choices — in the app only
  formatsSel: string[];
  name: string | undefined; // the search box
  reader: ReaderFilter | undefined;
  readBy: string; // the Read by value as the menu writes it (readByValue), for the links and the saved view
  sort: 'added' | 'title' | 'author' | 'rating' | 'completed';
  addedYears: number | undefined; // the decluttering filters: added this many years ago or more…
  unplayedMonths: number | undefined; // …and not played in this many months
  filtered: boolean;
};

/** A whole number from 1 to 99, else none: the decluttering filters' "years since added" and "months since played". */
const smallCount = (raw: string | null): number | undefined => (raw && /^\d{1,2}$/.test(raw) && Number(raw) > 0 ? Number(raw) : undefined);

/**
 * Reads a shelf's filter bar from a query string — the shelf's own URL, or a saved view's params (§16 #81), which
 * are nothing more than one of these as the bar wrote it. Every value is checked here, so a stored view can carry
 * only what the bar can: an unknown key or value is dropped. "Read by" names are resolved for whoever is looking:
 * a saved "Read by me" is each member's own.
 */
export function parseShelfQuery(sp: URLSearchParams, me: number, people: Array<{ id: number }>): ShelfQuery {
  // Filters are any-of checkbox groups, so params repeat: ?type=book&type=vinyl.
  const mediaTypes = [...new Set(sp.getAll('type'))].filter((t): t is MediaType => (MEDIA_TYPES as readonly string[]).includes(t));
  const statuses = [...new Set(sp.getAll('status'))].filter((st): st is ItemStatus => (ITEM_STATUSES as readonly string[]).includes(st));
  // Ownership is two checkboxes over one tri-state: exactly one checked filters; both or neither means "owned + logged" (no filter).
  // With Borrowed (§16 #82) among the choices the filter is any-of, in the app only: a share captures `owned` alone.
  const ownedSel = [...new Set(sp.getAll('owned'))].filter((v) => v === '1' || v === '0' || v === 'b');
  const borrowedSel = ownedSel.includes('b');
  const owned = !borrowedSel && ownedSel.length === 1 ? ownedSel[0] === '1' : undefined;
  const holding = borrowedSel
    ? ownedSel.map((v) => (v === '1' ? ('owned' as const) : v === '0' ? ('not_owned' as const) : ('borrowed' as const)))
    : undefined;
  // held in any of these forms (§16 #75): the shelf's own filter, never captured by a share link
  const formatsSel = [...new Set(sp.getAll('format'))].filter((f) => ALL_FORMATS.some((k) => k.code === f));
  const name = (sp.get('q') ?? '').trim().slice(0, 200) || undefined;
  const reader = parseReadBy(sp.get('readBy') ?? undefined, me, people);
  const readBy = reader ? readByValue(sp.get('readBy') ?? undefined) : '';
  const sortQ = sp.get('sort');
  const sort = sortQ === 'title' || sortQ === 'author' || sortQ === 'rating' || sortQ === 'completed' ? sortQ : 'added';
  const addedYears = smallCount(sp.get('addedYears'));
  const unplayedMonths = smallCount(sp.get('unplayedMonths'));
  const filtered =
    mediaTypes.length > 0 ||
    statuses.length > 0 ||
    owned !== undefined ||
    name !== undefined ||
    !!reader ||
    formatsSel.length > 0 ||
    holding !== undefined ||
    addedYears !== undefined ||
    unplayedMonths !== undefined;
  return { mediaTypes, statuses, ownedSel, owned, holding, formatsSel, name, reader, readBy, sort, addedYears, unplayedMonths, filtered };
}

/** The query string a ShelfQuery writes: what the bar's links carry and a saved view stores. The page and the display (table or covers) are the URL's own. */
export function shelfQueryString(q: ShelfQuery): string {
  const params = new URLSearchParams();
  for (const t of q.mediaTypes) params.append('type', t);
  for (const st of q.statuses) params.append('status', st);
  for (const o of q.ownedSel) params.append('owned', o);
  for (const f of q.formatsSel) params.append('format', f);
  if (q.name) params.set('q', q.name);
  if (q.readBy) params.set('readBy', q.readBy);
  if (q.sort !== 'added') params.set('sort', q.sort);
  if (q.addedYears !== undefined) params.set('addedYears', String(q.addedYears));
  if (q.unplayedMonths !== undefined) params.set('unplayedMonths', String(q.unplayedMonths));
  return params.toString();
}

/** The two decluttering views every shelf offers (§16 #81): bought and never read, and not played in a year (games and records only). */
export const PRESET_VIEWS = [
  { slug: 'unread-for-years', name: 'Unread for years', key: 'shelf.preset.unread_for_years', params: 'owned=1&status=not_started&addedYears=3', playable: false },
  { slug: 'not-played-lately', name: 'Not played lately', key: 'shelf.preset.not_played_lately', params: 'owned=1&unplayedMonths=12', playable: true },
] as const;

/** The same filters, however the keys are ordered. */
const sameQuery = (a: string, b: string) => {
  const norm = (qs: string) => [...new URLSearchParams(qs)].map(([k, v]) => `${k}=${v}`).sort().join('&');
  return norm(a) === norm(b);
};

/** The row of views under the filter bar: the presets, the shelf's saved views, and "Save view" — or "Delete view" while a saved one is open. */
const ViewsBar: FC<{ libraryId: number; views: SavedView[]; active: SavedView | undefined; query: string; playable: boolean }> = ({
  libraryId,
  views,
  active,
  query,
  playable,
}) => {
  const { t } = useI18n();
  const pill = (href: string, name: string, current: boolean) => (
    <a href={href} class={current ? 'pill active' : 'pill'} aria-current={current ? 'page' : undefined}>
      {name}
    </a>
  );
  return (
    <nav class="views" aria-label={t('shelf.views')}>
      <span class="eyebrow">{t('shelf.views')}</span>
      {PRESET_VIEWS.filter((p) => !p.playable || playable).map((p) => pill(`/libraries/${libraryId}?${p.params}`, t(p.key), !active && sameQuery(query, p.params)))}
      {views.map((v) => pill(`/libraries/${libraryId}?saved=${v.id}`, v.name, active?.id === v.id))}
      {active ? (
        <form method="post" action={`/libraries/${libraryId}/views/${active.id}/delete`} class="inline-form">
          <button type="submit" class="btn-danger">
            {t('shelf.delete_view')}
          </button>
        </form>
      ) : views.length >= MAX_SAVED_VIEWS_PER_SHELF ? (
        <span class="muted">{t('shelf.views_full', { max: MAX_SAVED_VIEWS_PER_SHELF })}</span>
      ) : (
        <form method="post" action={`/libraries/${libraryId}/views`} class="inline-form">
          <input type="hidden" name="params" value={query} />
          <input name="name" placeholder={t('shelf.save_view_placeholder')} aria-label={t('shelf.view_name')} required maxlength={MAX_VIEW_NAME} />
          <button type="submit" class="btn">
            {t('shelf.save_view')}
          </button>
        </form>
      )}
    </nav>
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
  // Every shelf with its count, and every shelf's totals — what the household paid (§16 #61) and the types it holds —
  // in one call, one pass over the items (§16 #68): this shelf, bulk edit's "Move to shelf" and the shelf a move's
  // notice links to (§16 #47), the sidebar's list (handed to page()), and — on an unfiltered view — the count the
  // pages are worked out from, so the shelf's items aren't counted a second time.
  const { shelves, totals, views } = await shelvesWithTotals(c.env.DB);
  const lib = shelves.find((l) => l.id === id);
  if (!lib) return c.notFound();

  const user = c.get('user');
  const people = await listPeople(c.env.DB);
  const url = new URL(c.req.url);
  // a saved view (§16 #81), read in the shelves' batch: its stored query stands in for the URL's, which then carries only the page and the display
  const savedViews = views.filter((v) => v.libraryId === id);
  const active = savedViews.find((v) => v.id === Number(url.searchParams.get('saved')));
  const q = parseShelfQuery(active ? new URLSearchParams(active.params) : url.searchParams, user.id, people);
  const { mediaTypes, statuses, ownedSel, owned, formatsSel, name, reader, readBy, sort, filtered } = q;
  const view = url.searchParams.get('view') === 'grid' ? 'grid' : 'table';
  const pageNum = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
  // the decluttering filters, dated by the device's day (#69)
  const stale: StaleFilter | undefined =
    q.addedYears !== undefined || q.unplayedMonths !== undefined || q.holding !== undefined
      ? { today: todayOf(c), addedYearsAgo: q.addedYears, unplayedMonths: q.unplayedMonths, holding: q.holding }
      : undefined;

  // No filter at all, and nothing found: the shelf itself is empty, and the filters have nothing to work on.
  const { items, total, page: current, pages } = await listItems(
    c.env.DB,
    id,
    {
      mediaTypes,
      statuses,
      owned,
      formats: formatsSel,
      q: name,
      sort,
      page: pageNum,
    },
    reader,
    filtered ? undefined : lib.itemCount,
    stale,
  );
  const ids = items.map((i) => i.id);
  const [{ onLoan: onLoanIds, wanted: wantedIds, borrowed: borrowedIds }, tagsMap] = await Promise.all([
    shelfFlags(c.env.DB, ids), // loans and the "Wanted" badge (§16 #53), one call
    view === 'table' ? tagsForItems(c.env.DB, ids) : Promise.resolve(undefined),
  ]);
  const shelfTotal = totals.shelves.get(id);
  // Status is reading status: a shelf — or a view of it — holding only games and records (they take plays) leaves the
  // filter out, unless one is already applied, so it can still be cleared
  const typesHere = (shelfTotal?.byType ?? []).filter((t) => t.count > 0).map((t) => t.mediaType);
  const showStatus = statuses.length > 0 || (mediaTypes.length ? mediaTypes : typesHere).some((t) => !isPlayable(t));
  // everything on the shelf, whatever the filters: what deleting it takes with it
  const shelfCount = lib.itemCount;

  const query = shelfQueryString(q);
  const makeHref = (p: number, v = view) => {
    const params = new URLSearchParams(active ? `saved=${active.id}` : query);
    if (v !== 'table') params.set('view', v);
    if (p > 1) params.set('page', String(p));
    const qs = params.toString();
    return `/libraries/${id}${qs ? `?${qs}` : ''}`;
  };

  const shares = user.role === 'admin' ? await listShares(c.env.DB, id) : [];
  const origin = new URL(c.req.url).origin;
  const i18n = c.get('i18n');
  const { t, n } = i18n;

  return page(
    c,
    lib.name,
    <>
      <div class="page-head">
        <div>
          <h1>{lib.name}</h1>
          <span class="sub">
            {n('shelf.sub', total, { count: formatCount(total) })}
            {shares.length ? ` · ${visibilityLabel(i18n, shareVisibility(shares)).toUpperCase()}` : ''}
          </span>
        </div>
        <div class="page-actions">
          {/* the board games here, or a view filtered to them: "What should we play tonight?" is a click away (§16 #60) */}
          {mediaTypes.includes('boardgame') || items.some((i) => i.mediaType === 'boardgame') ? (
            <a href="/play" class="btn">
              {t('shelf.play_tonight')}
            </a>
          ) : null}
          <a href="/add" class="btn">
            {t('shelf.add_items')}
          </a>
        </div>
      </div>

      {shelfTotal ? <PaidTotals totals={shelfTotal} household={totals.currency} /> : null}

      <BulkNotice query={c.req.query()} libraries={shelves} />

      {total === 0 && !filtered ? null : (
        <>
          {/* above the filter bar, so the bar and the table keep the spacing the open menus were tuned to (target size) */}
          <ViewsBar libraryId={id} views={savedViews} active={active} query={query} playable={typesHere.some(isPlayable)} />
          <form method="get" action={`/libraries/${id}`} class="toolbar">
          {view !== 'table' ? <input type="hidden" name="view" value={view} /> : null}
          <input
            type="search"
            name="q"
            value={name ?? ''}
            placeholder={t('shelf.filter_placeholder')}
            aria-label={t('shelf.filter_label')}
          />
          <FilterMenu label={t('filter.type')} name="type" options={MEDIA_TYPES.map((type) => [type, mediaLabel(i18n, type)] as const)} selected={mediaTypes} />
          {showStatus ? (
            <FilterMenu
              label={t('filter.status')}
              name="status"
              options={ITEM_STATUSES.map((st) => [st, statusLabel(i18n, st)] as const)}
              selected={statuses}
            />
          ) : null}
          <FilterMenu
            label={t('filter.holding')}
            name="owned"
            options={[
              ['1', t('filter.owned')],
              ['0', t('filter.logged')],
              ['b', t('filter.borrowed')],
            ]}
            selected={ownedSel}
          />
          <FilterMenu label={t('filter.format')} name="format" options={ALL_FORMATS.map((f) => [f.code, f.label] as const)} selected={formatsSel} />
          {/* "Read by" is reading too: not for a view of games and records only, unless it is already applied */}
          {(people.length > 1 && showStatus) || reader ? <ReadByMenu value={readBy} me={user.id} people={people} /> : null}
          <select name="sort" aria-label={t('sort.label')}>
            <option value="added" selected={sort === 'added'}>
              {t('sort.added')}
            </option>
            <option value="title" selected={sort === 'title'}>
              {t('sort.title')}
            </option>
            <option value="author" selected={sort === 'author'}>
              {t('sort.author')}
            </option>
            <option value="rating" selected={sort === 'rating'}>
              {t('sort.rating')}
            </option>
            <option value="completed" selected={sort === 'completed'}>
              {t('sort.completed')}
            </option>
          </select>
          <button type="submit" class="btn">
            {t('shelf.apply')}
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
                {t('shelf.table')}
              </a>
              <a href={makeHref(1, 'grid')} class={view === 'grid' ? 'active' : undefined}>
                {t('shelf.covers')}
              </a>
            </span>
          </span>
          </form>
        </>
      )}

      {items.length ? (
        view === 'table' ? (
          <ItemTable items={items} onLoanIds={onLoanIds} wantedIds={wantedIds} borrowedIds={borrowedIds} tagsMap={tagsMap} selectable />
        ) : (
          <ItemGrid items={items} onLoanIds={onLoanIds} wantedIds={wantedIds} borrowedIds={borrowedIds} selectable />
        )
      ) : total === 0 && !filtered ? (
        <p class="muted">
          <Fill text={t('shelf.empty')} with={{ addItems: <a href="/add">{t('shelf.empty_add')}</a>, importCsv: <a href="/import">{t('shelf.empty_import')}</a> }} />
        </p>
      ) : (
        <p class="muted">{t('shelf.no_match')}</p>
      )}
      {items.length ? (
        <BulkBar back={makeHref(current)} admin={user.role === 'admin'} libraries={shelves} currentLibrary={id} />
      ) : null}
      <Pagination page={current} pages={pages} makeHref={(p) => makeHref(p)} />

      <details>
        <summary>{t('shelf.settings')}</summary>
        <form method="post" action={`/libraries/${id}`} class="inline-form">
          <input name="name" value={lib.name} aria-label={t('shelf.name')} required />
          <button type="submit">{t('shelf.rename')}</button>
        </form>
        {user.role === 'admin' ? (
          <div class="share-panel">
            <h2 class="share-panel-head">{t('shelf.share_links')}</h2>
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
                    {t('shelf.rotate')}
                  </button>
                  <button name="action" value="delete" class="btn-danger">
                    {t('shelf.remove')}
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
              <input name="name" class="share-name" placeholder={t('shelf.link_name_placeholder')} aria-label={t('shelf.link_name')} required />
              <button type="submit">{t('shelf.publish')}</button>
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
              {/* every filter the form above has no field for, named, so the link never silently shows more than the screen:
                  who read what (§16 #43), the Format filter (§16 #75), the Holding filter's Borrowed choice (§16 #82), the
                  decluttering filters (§16 #81) and the search box, which matches where things are kept (§16 #51) */}
              {(() => {
                const dropped = [
                  reader ? '"Read by"' : null,
                  formatsSel.length ? 'Format' : null,
                  q.holding !== undefined ? 'Borrowed from someone' : null,
                  q.addedYears !== undefined ? 'Unread for years' : null,
                  q.unplayedMonths !== undefined ? 'Not played lately' : null,
                  name ? 'the search box' : null,
                ].filter((f): f is string => f !== null);
                if (!dropped.length) return '';
                const list = dropped.length === 1 ? dropped[0] : `${dropped.slice(0, -1).join(', ')} and ${dropped[dropped.length - 1]}`;
                return dropped.length === 1
                  ? ` ${list} is never published: the link shows this view without it.`
                  : ` ${list} are never published: the link shows this view without them.`;
              })()}{' '}
              Public pages show only whitelisted fields — never notes, loans, or copy counts.
            </small>
          </div>
        ) : null}
        {/* deleting a shelf is an admin's (§16 #74): its items go to the trash, which only an admin can restore from */}
        {user.role === 'admin' ? (
          <>
            <hr />
            <form
              method="post"
              action={`/libraries/${id}/delete`}
              data-confirm={
                shelfCount
                  ? n('shelf.delete_confirm', shelfCount, { name: lib.name, days: TRASH_DAYS })
                  : t('shelf.delete_confirm_empty', { name: lib.name })
              }
            >
              <button type="submit" class="btn-danger">
                {t('shelf.delete')}
              </button>
            </form>
          </>
        ) : null}
      </details>
    </>,
    shelves,
  );
});

/** Saves the shelf's current filters under a name — any member's, replacing a view of that name (§16 #81). */
libraries.post('/libraries/:id/views', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const name = String(body['name'] ?? '').trim().slice(0, MAX_VIEW_NAME);
  if (!name) return c.text('A view needs a name', 400);
  const user = c.get('user');
  const people = await listPeople(c.env.DB);
  // stored as the bar would write it: only the keys the bar knows, each value checked — never the page or the display
  const params = shelfQueryString(parseShelfQuery(new URLSearchParams(String(body['params'] ?? '').slice(0, 2000)), user.id, people));
  const saved = await saveView(c.env.DB, { libraryId: id, name, params, createdBy: user.id });
  // full, or the shelf is gone: back to the filters as they were
  return c.redirect(saved === null ? `/libraries/${id}${params ? `?${params}` : ''}` : `/libraries/${id}?saved=${saved}`);
});

libraries.post('/libraries/:id/views/:vid/delete', async (c) => {
  const id = Number(c.req.param('id'));
  await deleteSavedView(c.env.DB, id, Number(c.req.param('vid')));
  return c.redirect(`/libraries/${id}`);
});

libraries.post('/libraries/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const name = String(body['name'] ?? '').trim();
  if (name) await renameLibrary(c.env.DB, id, name);
  return c.redirect(`/libraries/${id}`);
});

/** Deletes a shelf, its items into the trash (§16 #74): an admin's, as deleting in bulk is (§16 #47) — the one path that took a whole shelf for good was open to every member. */
libraries.post('/libraries/:id/delete', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') return c.text('Only an admin can delete a shelf. A member can delete an item from its own page.', 403);
  const id = Number(c.req.param('id'));
  const { expired } = await deleteLibrary(c.env.DB, id, { id: user.id, sessionKey: user.sessionKey });
  c.executionCtx.waitUntil(Promise.all(expired.map((k) => deleteCover(c.env.COVERS, k)))); // purged rows' covers — the shelf's items keep theirs in the trash
  return c.redirect('/');
});

export default libraries;
