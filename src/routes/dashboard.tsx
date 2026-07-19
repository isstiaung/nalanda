import { Hono } from 'hono';
import { activeLoans, holdingsByType, listLibraries, listShares, recentItems } from '../db/queries';
import type { AppEnv } from '../env';
import { ItemGrid, MEDIA_LABEL, MEDIA_PLURAL, Stat } from '../views/components';
import { page } from '../views/layout';

const dashboard = new Hono<AppEnv>();

dashboard.get('/', async (c) => {
  const [libraries, recent, loans, holdings, shares] = await Promise.all([
    listLibraries(c.env.DB),
    recentItems(c.env.DB, 12),
    activeLoans(c.env.DB),
    holdingsByType(c.env.DB),
    listShares(c.env.DB),
  ]);
  const shareCounts = new Map<number | null, number>();
  for (const v of shares) shareCounts.set(v.libraryId, (shareCounts.get(v.libraryId) ?? 0) + 1);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = loans.filter((l) => l.dueOn && l.dueOn < today).length;
  const owned = holdings.reduce((n, h) => n + h.owned, 0);
  const notOwned = holdings.reduce((n, h) => n + h.notOwned, 0);
  const typeLine = (pick: (h: (typeof holdings)[number]) => number) =>
    holdings
      .filter((h) => pick(h) > 0)
      .map((h) => `${pick(h)} ${pick(h) === 1 ? MEDIA_LABEL[h.mediaType].toLowerCase() : MEDIA_PLURAL[h.mediaType]}`)
      .join(' · ');

  return page(
    c,
    'Overview',
    <>
      <div class="page-head">
        <h1>Overview</h1>
        <div class="page-actions">
          <a href="/add" role="button" class="btn-primary">
            Add items
          </a>
        </div>
      </div>

      <form method="get" action="/search" role="search">
        <input type="search" name="q" placeholder="Search the whole collection…" aria-label="Search" />
      </form>

      <section>
        <div class="stat-row">
          <Stat n={owned} label="Owned" detail={typeLine((h) => h.owned)} />
          {notOwned > 0 ? <Stat n={notOwned} label="Not owned" detail={typeLine((h) => h.notOwned)} /> : null}
          <Stat n={libraries.length} label="Shelves" />
          <Stat n={loans.length} label="On loan" />
          <Stat n={overdue} label="Overdue" warn={overdue > 0} />
        </div>
      </section>

      <section>
        <p class="eyebrow">Shelves</p>
        {libraries.length ? (
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>Shelf</th>
                  <th>Items</th>
                  <th>Visibility</th>
                  <th class="hide-sm">Created</th>
                </tr>
              </thead>
              <tbody>
                {libraries.map((l) => (
                  <tr>
                    <td>
                      <a href={`/libraries/${l.id}`}>
                        <strong>{l.name}</strong>
                      </a>
                    </td>
                    <td class="num">{l.itemCount}</td>
                    <td>
                      {shareCounts.get(l.id) ? (
                        <span class="pill shared">
                          {shareCounts.get(l.id) === 1 ? 'Shared' : `${shareCounts.get(l.id)} links`}
                        </span>
                      ) : (
                        <span class="pill">Private</span>
                      )}
                    </td>
                    <td class="date hide-sm">{l.createdAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <details>
          <summary>New shelf</summary>
          <form method="post" action="/libraries" class="inline-form">
            <input name="name" placeholder="e.g. Wishlist" required />
            <button type="submit">Create shelf</button>
          </form>
        </details>
      </section>

      {loans.length ? (
        <section>
          <p class="eyebrow">Circulation</p>
          <p>
            {loans.length} {loans.length === 1 ? 'item' : 'items'} out
            {overdue ? (
              <>
                {' · '}
                <span class="error">{overdue} overdue</span>
              </>
            ) : null}
            {' — '}
            <a href="/loans">manage loans</a>
          </p>
        </section>
      ) : null}

      <section>
        <p class="eyebrow">Recently accessioned</p>
        {recent.length ? (
          <ItemGrid items={recent} />
        ) : (
          <p class="muted">Nothing on the shelves yet — add your first item by scanning its barcode.</p>
        )}
      </section>
    </>,
  );
});

export default dashboard;
