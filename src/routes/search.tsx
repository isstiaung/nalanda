import { Hono } from 'hono';
import { listLibraries, listPeople, searchItems, shelfFlags } from '../db/queries';
import type { AppEnv } from '../env';
import { ItemTable } from '../views/components';
import { BulkBar, BulkNotice } from '../views/bulk';
import { page } from '../views/layout';
import { parseReadBy, readByValue, ReadByMenu } from './libraries';

const search = new Hono<AppEnv>();

/** The most results one search shows, best matches first. */
const SEARCH_LIMIT = 50;

search.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const user = c.get('user');
  // "Read by", as on a shelf (§16 #43) — narrowed inside the search itself, so it still finds up to 50
  const people = await listPeople(c.env.DB);
  const reader = parseReadBy(c.req.query('readBy'), user.id, people);
  const readBy = reader ? readByValue(c.req.query('readBy')) : ''; // as the menu writes it, so the menu shows it selected
  const items = q ? await searchItems(c.env.DB, q, SEARCH_LIMIT, reader) : [];
  // a full page is the cap, not the count: there may be more, so the heading says "best" and a line says how to narrow it
  const capped = items.length >= SEARCH_LIMIT;
  // the Shelf column, and bulk edit's "Move to shelf" and its notice (§16 #47) — and then the sidebar's list too (§16 #68)
  const listed = items.length > 0 || !!c.req.query('bulk');
  const [{ onLoan: onLoanIds, wanted: wantedIds, borrowed: borrowedIds }, libs] = await Promise.all([
    shelfFlags(c.env.DB, items.map((i) => i.id)), // loans and the "Wanted" badge (§16 #53), one call
    listed ? listLibraries(c.env.DB) : Promise.resolve([]),
  ]);
  const libraryNames = new Map(libs.map((l) => [l.id, l.name]));
  // where a bulk action comes back to: this search, as it was asked
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (readBy) params.set('readBy', readBy);
  const qs = params.toString();
  const back = `/search${qs ? `?${qs}` : ''}`;

  return page(
    c,
    q ? `Search: ${q}` : 'Search',
    <>
      <div class="page-head">
        <div>
          <h1>Search</h1>
          {q ? (
            <span class="sub">
              {capped ? `THE ${items.length} BEST` : items.length} {items.length === 1 ? 'RESULT' : 'RESULTS'} FOR “{q.toUpperCase()}”
            </span>
          ) : (
            <span class="sub">TITLES · CREATORS · DESCRIPTIONS · NOTES · LOCATIONS</span>
          )}
        </div>
      </div>
      <BulkNotice query={c.req.query()} libraries={libs} />
      <form method="get" action="/search" role="search" class={people.length > 1 ? 'search-by-reader' : undefined}>
        {/* eslint-disable-next-line no-restricted-syntax -- this page is a search box: typing is why you came */}
        <input type="search" name="q" value={q} placeholder="Search the catalog…" aria-label="Search the catalog" aria-describedby="search-help" autofocus />
        {people.length > 1 || reader ? (
          <>
            <ReadByMenu value={readBy} me={user.id} people={people} />
            {/* the form's own action: a plain submit */}
            <button type="submit">Search</button>
          </>
        ) : null}
      </form>
      <p class="muted form-note search-help" id="search-help">
        Narrow with <code>author:</code>, <code>title:</code>, <code>tag:</code>, <code>status:</code> (unread, reading, read, abandoned),{' '}
        <code>year:</code> (2019, or 2010-2019), <code>lang:</code> (a code or a name) and <code>type:</code> (book, game, record). Quote a phrase:{' '}
        <code>author:"le guin"</code>. Operators can stand alone — <code>tag:fantasy status:unread</code> lists by title.
      </p>
      {q ? (
        items.length ? (
          <>
            <ItemTable items={items} onLoanIds={onLoanIds} wantedIds={wantedIds} borrowedIds={borrowedIds} libraryNames={libraryNames} selectable />
            {capped ? (
              <p class="muted form-note">
                Showing the {SEARCH_LIMIT} best matches — there may be more. Add a word to narrow the search, or filter a shelf.
              </p>
            ) : null}
            <BulkBar back={back} admin={user.role === 'admin'} libraries={libs} />
          </>
        ) : (
          <p class="muted">Nothing found for “{q}”. Search covers titles, creators, descriptions, notes, and locations — and the operators above.</p>
        )
      ) : null}
    </>,
    listed ? libs : undefined,
  );
});

export default search;
