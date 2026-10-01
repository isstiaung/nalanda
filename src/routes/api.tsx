// The read-only API (ARCH.md §16 #88): GET /api/v1/…, JSON, with a member's token in `Authorization: Bearer nal_…`.
// A token sees what its member sees and can change nothing: every route here is a read the app's own pages make,
// through the same queries, under the same per-member rules ("Read by" is the viewer's, the want list and goals are
// the token's member's). Mounted before the session middleware (src/index.ts): a cookie signs nobody in here, and a
// token signs nobody in anywhere else. Items page by id, API_PAGE a request, as the export does (§16 #38).
import { Hono, type Context } from 'hono';
import {
  activeLoans,
  activeLoansForItem,
  API_PAGE,
  apiItems,
  apiTokenUser,
  getItem,
  goalOf,
  listLibraries,
  listPeople,
  loanHistory,
  readingLog,
  searchItems,
  tagsForIdRange,
  tagsForItem,
  type StaleFilter,
} from '../db/queries';
import type { AppEnv } from '../env';
import { hashApiToken, isApiToken } from '../lib/auth';
import { VERSION } from '../version';
import { page as _page, todayOf } from '../views/layout';
import { parseReadBy, parseShelfQuery } from './libraries';

void _page; // the layout is for pages; the API answers JSON — the import keeps todayOf's module in one place

const api = new Hono<AppEnv>();

const refuse = (c: Context<AppEnv>, status: 401 | 403 | 404 | 405 | 400, error: string) => c.json({ error }, status);

/** The token, then the account it still signs in — the same checks a session passes (sessionMatches), in one call. */
api.use('/api/v1/*', async (c, next) => {
  c.header('cache-control', 'no-store');
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return refuse(c, 405, 'The API is read-only: GET only.');
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m || !isApiToken(m[1]!)) return refuse(c, 401, 'A token is needed: "Authorization: Bearer <token>", made on your Account page.');
  const user = await apiTokenUser(c.env.DB, await hashApiToken(m[1]!));
  if (!user) return refuse(c, 401, 'This token no longer signs anyone in.');
  if (user.mustChangePassword) return refuse(c, 403, 'Choose a new password on the Account page first.');
  c.set('user', {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    sessionKey: user.sessionKey,
    sessionGeneration: user.sessionGeneration,
  });
  await next();
});

/** Whose token this is. */
api.get('/api/v1/me', (c) => {
  const user = c.get('user');
  return c.json({ id: user.id, username: user.username, role: user.role, version: VERSION });
});

/** The shelves, with their counts — the `library` a request for items may name. */
api.get('/api/v1/libraries', async (c) => {
  const libraries = await listLibraries(c.env.DB);
  return c.json({ libraries: libraries.map((l) => ({ id: l.id, name: l.name, itemCount: l.itemCount })) });
});

/** A positive whole number from a query value, or null. */
const id = (raw: string | undefined | null): number | null => (raw && /^\d{1,15}$/.test(raw) ? Number(raw) : null);

/**
 * Items, with the shelf's filters as its URL carries them (type, status, owned, format, tag, q, readBy, sort,
 * addedYears, unplayedMonths — parseShelfQuery), on one shelf (`library`) or every shelf, paged by id: `after` is the
 * last id of the previous page, `next` the one to ask for next, absent on the last page. The order is by id — the
 * sort a shelf chooses is the page's, not a page-by-page cursor's.
 */
api.get('/api/v1/items', async (c) => {
  const url = new URL(c.req.url);
  const library = url.searchParams.get('library');
  const libraryId = library === null ? null : id(library);
  if (library !== null && libraryId === null) return refuse(c, 400, 'library must be a shelf id.');
  const after = url.searchParams.get('after');
  if (after !== null && id(after) === null && after !== '0') return refuse(c, 400, 'after must be an item id.');
  const user = c.get('user');
  const people = await listPeople(c.env.DB);
  const q = parseShelfQuery(url.searchParams, user.id, people);
  const stale: StaleFilter | undefined =
    q.addedYears !== undefined || q.unplayedMonths !== undefined || q.holding !== undefined
      ? { today: todayOf(c), addedYearsAgo: q.addedYears, unplayedMonths: q.unplayedMonths, holding: q.holding }
      : undefined;
  const tag = url.searchParams.get('tag')?.trim().toLowerCase() || undefined;
  const found = await apiItems(
    c.env.DB,
    libraryId,
    { mediaTypes: q.mediaTypes, statuses: q.statuses, owned: q.owned, formats: q.formatsSel, q: q.name, tag },
    q.reader,
    stale,
    Number(after ?? 0),
  );
  const items = found.slice(0, API_PAGE);
  const tags = items.length ? await tagsForIdRange(c.env.DB, items[0]!.id, items.at(-1)!.id, libraryId ?? undefined) : new Map<number, string[]>();
  return c.json({
    items: items.map((item) => ({ ...item, tags: tags.get(item.id) ?? [] })),
    ...(found.length > API_PAGE ? { next: items.at(-1)!.id } : {}),
  });
});

/** One item with everything its page shows: tags, every read with its reader, the reviews, the pages recorded, the loans out. */
api.get('/api/v1/items/:id', async (c) => {
  const itemId = id(c.req.param('id'));
  const item = itemId === null ? null : await getItem(c.env.DB, itemId);
  if (!item) return refuse(c, 404, 'No such item.');
  const [tags, log, loans, people] = await Promise.all([tagsForItem(c.env.DB, item.id), readingLog(c.env.DB, item.id), activeLoansForItem(c.env.DB, item.id), listPeople(c.env.DB)]);
  return c.json({ item: { ...item, tags }, reads: log.reads, reviews: log.reviews, progress: log.entries, loans, people });
});

/** The search box, with its operators (§16 #80): the fifty best matches, "Read by" as the shelf takes it. */
api.get('/api/v1/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return refuse(c, 400, 'q is needed.');
  const user = c.get('user');
  const people = await listPeople(c.env.DB);
  const items = await searchItems(c.env.DB, q, 50, parseReadBy(c.req.query('readBy'), user.id, people));
  return c.json({ items });
});

/** What is out on loan, and the latest returns. */
api.get('/api/v1/loans', async (c) => {
  const [out, returned] = await Promise.all([activeLoans(c.env.DB), loanHistory(c.env.DB, 100)]);
  return c.json({ out, returned });
});

/** The token's member's own want list, newest want first by id paging. */
api.get('/api/v1/wants', async (c) => {
  const after = c.req.query('after');
  if (after !== undefined && id(after) === null && after !== '0') return refuse(c, 400, 'after must be an item id.');
  const user = c.get('user');
  const found = await apiItems(c.env.DB, null, { wantedBy: user.id }, undefined, undefined, Number(after ?? 0));
  const items = found.slice(0, API_PAGE);
  return c.json({ items, ...(found.length > API_PAGE ? { next: items.at(-1)!.id } : {}) });
});

/** The token's member's reading goal for a year (this one unless `year` says), with its count — or null. */
api.get('/api/v1/goals', async (c) => {
  const user = c.get('user');
  const yearRaw = c.req.query('year');
  const year = yearRaw === undefined ? Number(todayOf(c).slice(0, 4)) : /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
  if (year === null) return refuse(c, 400, 'year must be four digits.');
  return c.json({ year, goal: await goalOf(c.env.DB, user.id, year) });
});

api.all('/api/v1/*', (c) => refuse(c, 404, 'No such route. See runbooks/api.md.'));

export default api;
