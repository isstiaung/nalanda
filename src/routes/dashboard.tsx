import { Hono } from 'hono';
import { goalOf, listShares, pickNextRead, recentItems, shelvesWithTotals, type SavedView } from '../db/queries';
import { formatCount, formatMoney } from '../lib/money';
import type { Share } from '../db/schema';
import type { AppEnv } from '../env';
import { shareVisibility } from '../lib/share';
import { GoalMeter, ItemGrid, ReadNextCard, Stat } from '../views/components';
import { Fill, mediaCount, visibilityLabel } from '../views/i18n';
import { page, partial, todayOf } from '../views/layout';
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
  if (c.req.header('HX-Request')) return partial(c, <ReadNextCard pick={await pickNextRead(c.env.DB, reader, notId)} />);

  const i18n = c.get('i18n');
  const { t, n } = i18n;
  const today = todayOf(c);
  const year = Number(today.slice(0, 4));
  const [{ shelves: libraries, totals, holdings, views: savedViews, loans }, recent, shares, pick, goal] = await Promise.all([
    // the shelves and their counts, what the household paid per shelf and currency (§16 #61), the holdings by type and
    // the loans out and overdue by today, counted in SQL — one call, one pass over the items (§16 #68)
    shelvesWithTotals(c.env.DB, today),
    recentItems(c.env.DB, 12),
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
  // every shelf's saved views (§16 #81), listed under its name — read in the shelves' batch
  const viewsByLibrary = new Map<number, SavedView[]>();
  for (const v of savedViews) viewsByLibrary.set(v.libraryId, [...(viewsByLibrary.get(v.libraryId) ?? []), v]);
  for (const v of shares) sharesByLibrary.set(v.libraryId, [...(sharesByLibrary.get(v.libraryId) ?? []), v]);
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
      .map((h) => mediaCount(i18n, h.mediaType, pick(h)))
      .join(' · ');

  return page(
    c,
    t('overview.title'),
    <>
      <div class="page-head">
        <h1>{t('overview.title')}</h1>
        <div class="page-actions">
          <a href="/add" class="btn btn-primary">
            {t('nav.add')}
          </a>
        </div>
      </div>

      <form method="get" action="/search" role="search">
        <input type="search" name="q" placeholder={t('overview.search_placeholder')} aria-label={t('overview.search')} />
      </form>

      <section>
        <div class="stat-row">
          <Stat n={owned} label={t('overview.owned')} detail={typeLine((h) => h.owned)} />
          {notOwned > 0 ? <Stat n={notOwned} label={t('overview.not_owned')} detail={typeLine((h) => h.notOwned)} /> : null}
          <Stat n={libraries.length} label={t('overview.shelves')} />
          <Stat n={loans.open} label={t('overview.on_loan')} />
          <Stat n={loans.overdue} label={t('overview.overdue')} warn={loans.overdue > 0} />
        </div>
      </section>

      {goal || hasBooks ? (
      <section class="goal" id="goal">
        <p class="eyebrow">{t('overview.goal', { year })}</p>
        {goal ? (
          <>
            <GoalMeter count={goal.count} target={goal.target} year={year} today={today} />
            <a href="/goals" class="goal-edit">
              {t('overview.change_goal')}
            </a>
          </>
        ) : (
          <p class="muted">
            <Fill text={t('overview.no_goal', { year })} with={{ setOne: <a href="/goals">{t('overview.set_one')}</a> }} />
          </p>
        )}
      </section>
      ) : null}

      {hasBooks ? (
        <section aria-labelledby="read-next-head">
          <p class="eyebrow" id="read-next-head">
            {t('overview.read_next')}
          </p>
          <div id="read-next" aria-live="polite">
            <ReadNextCard pick={pick} />
          </div>
        </section>
      ) : null}

      {gamesOwned > 0 ? (
        <section aria-labelledby="game-night-head">
          <p class="eyebrow" id="game-night-head">
            {t('overview.game_night')}
          </p>
          <p class="game-night">
            <a href="/play">{t('overview.play_tonight')}</a>{' '}
            <span class="muted">{gamesOwned === 1 ? t('overview.one_game') : t('overview.pick_games', { count: gamesOwned })}</span>
          </p>
        </section>
      ) : null}

      <section>
        <p class="eyebrow">{t('overview.shelves')}</p>
        {libraries.length ? (
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>{t('overview.shelf')}</th>
                  <th>{t('overview.items')}</th>
                  <th>{t('overview.visibility')}</th>
                  {anyPaid ? <th class="num">{t('overview.paid')}</th> : null}
                  <th class="hide-sm">{t('overview.created')}</th>
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
                        {viewsByLibrary.get(l.id)?.length ? (
                          <span class="shelf-views">
                            {viewsByLibrary.get(l.id)!.map((v) => (
                              <a href={`/libraries/${l.id}?saved=${v.id}`} class="pill">
                                {v.name}
                              </a>
                            ))}
                          </span>
                        ) : null}
                      </td>
                      <td class="num">{formatCount(l.itemCount)}</td>
                      <td>
                        <span class={visibility.kind === 'private' ? 'pill' : 'pill shared'}>
                          {visibilityLabel(i18n, visibility)}
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
          <summary>{t('overview.new_shelf')}</summary>
          <form method="post" action="/libraries" class="inline-form">
            <input name="name" placeholder={t('overview.shelf_name_placeholder')} aria-label={t('overview.shelf_name')} required />
            <button type="submit">{t('overview.create_shelf')}</button>
          </form>
        </details>
      </section>

      {loans.open ? (
        <section>
          <p class="eyebrow">{t('overview.circulation')}</p>
          <p>
            {n('overview.items_out', loans.open, { count: formatCount(loans.open) })}
            {loans.overdue ? (
              <>
                {' · '}
                <span class="error">{t('overview.overdue_count', { count: formatCount(loans.overdue) })}</span>
              </>
            ) : null}
            {' — '}
            <a href="/loans">{t('overview.manage_loans')}</a>
          </p>
        </section>
      ) : null}

      <section>
        <p class="eyebrow">{t('overview.recent')}</p>
        {recent.length ? (
          <ItemGrid items={recent} onLoanIds={onLoanIds} wantedIds={wantedIds} />
        ) : (
          <p class="muted">{t('overview.empty')}</p>
        )}
      </section>
    </>,
    libraries, // the sidebar's list too: read above, in this request (§16 #68)
  );
});

export default dashboard;
