import { Hono } from 'hono';
import { activeLoans, goalOf, listShares, pickNextRead, recentItems, shelvesWithTotals } from '../db/queries';
import { formatCount, formatMoney } from '../lib/money';
import type { Share } from '../db/schema';
import type { AppEnv } from '../env';
import { todayUtc } from '../lib/reads';
import { shareVisibility, shareVisibilityLabel } from '../lib/share';
import { GoalMeter, ItemGrid, MEDIA_LABEL, MEDIA_PLURAL, ReadNextCard, Stat } from '../views/components';
import { page } from '../views/layout';
import { ledgerDate } from '../lib/dates';

const dashboard = new Hono<AppEnv>();

/** The pick "Another" was pressed on, from `?not=` — anything but a positive id is none. */
function shownPick(raw: string | undefined): number | null {
  const id = Number(raw);
  return raw && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The Overview — or, for htmx, just its "Read next" card (ARCH.md §16 #46): "Another" asks for `/?not=<id>`, and
 * gets a new pick without the page's other queries. One URL answers both ways, so the response varies on HX-Request.
 */
dashboard.get('/', async (c) => {
  const reader = c.get('user').id;
  const notId = shownPick(c.req.query('not'));
  c.header('Vary', 'HX-Request');
  if (c.req.header('HX-Request')) return c.html(<ReadNextCard pick={await pickNextRead(c.env.DB, reader, notId)} />);

  const today = todayUtc();
  const year = Number(today.slice(0, 4));
  const [{ shelves: libraries, totals, holdings }, recent, loans, shares, pick, goal] = await Promise.all([
    // the shelves and their counts, what the household paid per shelf and currency (§16 #61) and the holdings by type —
    // one call, one pass over the items (§16 #68)
    shelvesWithTotals(c.env.DB),
    recentItems(c.env.DB, 12),
    activeLoans(c.env.DB),
    listShares(c.env.DB),
    pickNextRead(c.env.DB, reader, notId),
    // the signed-in member's own goal for this year (§16 #49) — one call, its count worked out in it
    goalOf(c.env.DB, reader, year),
  ]);
  // the recent cards' "Lent" and "Wanted" badges, as on a shelf (§16 #53) — they came with the items
  const onLoanIds = new Set(recent.filter((i) => i.onLoan).map((i) => i.id));
  const wantedIds = new Set(recent.filter((i) => i.wanted).map((i) => i.id));
  const anyPaid = [...totals.shelves.values()].some((t) => t.paid.length > 0);
  /** A shelf's paid totals, one per currency — the household's first; never added across currencies. */
  const paidCell = (id: number) =>
    [...(totals.shelves.get(id)?.paid ?? [])]
      .sort((a, b) => (a.currency === totals.currency ? -1 : b.currency === totals.currency ? 1 : a.currency.localeCompare(b.currency)))
      .map((t) => formatMoney(t.total, t.currency))
      .join(' · ');
  const sharesByLibrary = new Map<number | null, Share[]>();
  for (const v of shares) sharesByLibrary.set(v.libraryId, [...(sharesByLibrary.get(v.libraryId) ?? []), v]);
  const overdue = loans.filter((l) => l.dueOn && l.dueOn < today).length;
  const owned = holdings.reduce((n, h) => n + h.owned, 0);
  const notOwned = holdings.reduce((n, h) => n + h.notOwned, 0);
  // "Read next" is for books: a catalog without any leaves it off, rather than saying there's nothing to read
  const books = holdings.find((h) => h.mediaType === 'book');
  const hasBooks = !!books && books.owned + books.notOwned > 0;
  // "What should we play tonight?" (§16 #60) is for games in the collection: linked once there is one, at no D1 cost
  const gamesOwned = holdings.find((h) => h.mediaType === 'boardgame')?.owned ?? 0;
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
          <a href="/add" class="btn btn-primary">
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

      {goal || hasBooks ? (
      <section class="goal" id="goal">
        <p class="eyebrow">Reading goal · {year}</p>
        {goal ? (
          <>
            <GoalMeter count={goal.count} target={goal.target} year={year} today={today} />
            <a href="/goals" class="goal-edit">
              Change goal
            </a>
          </>
        ) : (
          <p class="muted">
            No reading goal for {year}. <a href="/goals">Set one</a> — how many books you mean to finish this year.
          </p>
        )}
      </section>
      ) : null}

      {hasBooks ? (
        <section aria-labelledby="read-next-head">
          <p class="eyebrow" id="read-next-head">
            Read next
          </p>
          <div id="read-next" aria-live="polite">
            <ReadNextCard pick={pick} />
          </div>
        </section>
      ) : null}

      {gamesOwned > 0 ? (
        <section aria-labelledby="game-night-head">
          <p class="eyebrow" id="game-night-head">
            Game night
          </p>
          <p class="game-night">
            <a href="/play">What should we play tonight?</a>{' '}
            <span class="muted">
              {gamesOwned === 1
                ? 'Check your one board game against players, time and weight.'
                : `Pick from ${gamesOwned} board games by players, time and weight.`}
            </span>
          </p>
        </section>
      ) : null}

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
                  {anyPaid ? <th class="num">Paid</th> : null}
                  <th class="hide-sm">Created</th>
                </tr>
              </thead>
              <tbody>
                {libraries.map((l) => {
                  const visibility = shareVisibility(sharesByLibrary.get(l.id) ?? []);
                  return (
                    <tr>
                      <td>
                        <a href={`/libraries/${l.id}`}>
                          <strong>{l.name}</strong>
                        </a>
                      </td>
                      <td class="num">{formatCount(l.itemCount)}</td>
                      <td>
                        <span class={visibility.kind === 'private' ? 'pill' : 'pill shared'}>
                          {shareVisibilityLabel(visibility)}
                        </span>
                      </td>
                      {anyPaid ? <td class="num money-cell">{paidCell(l.id) || '—'}</td> : null}
                      <td class="date hide-sm">{ledgerDate(l.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <details>
          <summary>New shelf</summary>
          <form method="post" action="/libraries" class="inline-form">
            <input name="name" placeholder="e.g. Wishlist" aria-label="Shelf name" required />
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
          <ItemGrid items={recent} onLoanIds={onLoanIds} wantedIds={wantedIds} />
        ) : (
          <p class="muted">Nothing on the shelves yet — add your first item by scanning its barcode.</p>
        )}
      </section>
    </>,
    libraries, // the sidebar's list too: read above, in this request (§16 #68)
  );
});

export default dashboard;
