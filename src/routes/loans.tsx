import { Hono } from 'hono';
import {
  activeLoans,
  borrowIfNotOwned,
  getItem,
  lendIfFree,
  loanHistory,
  returnBorrow,
  returnLoan,
} from '../db/queries';
import type { AppEnv } from '../env';
import { isIsoDate } from '../lib/reads';
import { page, todayOf } from '../views/layout';
import { formatLabel, formatsOf } from '../lib/formats';
import { loanRequestsSection } from './borrowing';

const loans = new Hono<AppEnv>();

/** How many returned loans the History table lists, newest first. */
const HISTORY_SHOWN = 100;

loans.get('/loans', async (c) => {
  // one past the page, so the count can say when there are more returns than the table lists
  const [active, past] = await Promise.all([activeLoans(c.env.DB), loanHistory(c.env.DB, HISTORY_SHOWN + 1)]);
  const history = past.slice(0, HISTORY_SHOWN);
  const returned = past.length > HISTORY_SHOWN ? `${HISTORY_SHOWN}+` : String(history.length);
  const today = todayOf(c);
  const requests = await loanRequestsSection(c); // null unless connections are enabled and someone asked

  return page(
    c,
    'Loans',
    <>
      <div class="page-head">
        <div>
          <h1>Loans</h1>
          <span class="sub">
            {active.length} OUT · {returned} RETURNED
          </span>
        </div>
      </div>

      {requests}

      <section>
        <p class="eyebrow">Out now</p>
        {active.length ? (
          <div class="data-table cards">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Borrower</th>
                  <th class="hide-sm">Since</th>
                  <th>Due</th>
                  <th class="actions-cell"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {active.map((l) => {
                  const overdue = !!(l.dueOn && l.dueOn < today);
                  return (
                    <tr>
                      <td>
                        <a href={`/items/${l.itemId}`}>
                          <strong>{l.itemTitle}</strong>
                        </a>
                      </td>
                      <td data-label="Borrower">
                        {l.borrower}
                        {l.edition ? <small class="muted"> · {formatLabel(l.edition).toLowerCase()}</small> : null}
                        {l.contact ? <small class="muted"> · {l.contact}</small> : null}
                      </td>
                      <td class="date hide-sm" data-label="Since">
                        {l.loanedOn}
                      </td>
                      <td class="date due-cell" data-label="Due">
                        {/* the date stays when it's passed: how overdue matters as much as that it is */}
                        <span>{l.dueOn ?? '—'}</span>
                        {overdue ? (
                          <>
                            {' '}
                            <span class="pill overdue">Overdue</span>
                          </>
                        ) : null}
                      </td>
                      <td class="actions-cell">
                        <form method="post" action={`/loans/${l.id}/return`}>
                          <button type="submit" class="btn">
                            Mark returned
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">Nothing is out on loan. Lend items from their detail page.</p>
        )}
      </section>

      <section>
        <p class="eyebrow">History{past.length > HISTORY_SHOWN ? ` · latest ${HISTORY_SHOWN}` : ''}</p>
        {history.length ? (
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Borrower</th>
                  <th class="hide-sm">Lent</th>
                  <th>Returned</th>
                </tr>
              </thead>
              <tbody>
                {history.map((l) => (
                  <tr>
                    <td>
                      <a href={`/items/${l.itemId}`}>{l.itemTitle}</a>
                    </td>
                    <td>{l.borrower}</td>
                    <td class="date hide-sm">{l.loanedOn}</td>
                    <td class="date">{l.returnedOn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">No returns recorded yet.</p>
        )}
      </section>
    </>,
  );
});

loans.post('/items/:id/loan', async (c) => {
  const itemId = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, itemId);
  if (!item) return c.notFound();
  if (item.copies === 0) return c.text('Not in the physical collection — nothing to lend.', 400);
  const body = await c.req.parseBody();
  const borrower = String(body['borrower'] ?? '').trim();
  if (borrower) {
    // which copy went out (§16 #75): only one of the item's own formats
    const edition = String(body['edition'] ?? '').trim();
    const lent = await lendIfFree(c.env.DB, {
      itemId,
      borrower,
      edition: formatsOf(item).includes(edition) ? edition : null,
      loanedOn: todayOf(c), // the device's day, not the server's (§16 #69)
      contact: String(body['contact'] ?? '').trim() || null,
      // a calendar date or none, as a connection's lend takes it: anything else couldn't round-trip through the export
      dueOn: isIsoDate(String(body['dueOn'] ?? '').trim()) ? String(body['dueOn']).trim() : null,
    });
    if (!lent) return c.text('Every copy is already out on loan.', 409);
  }
  return c.redirect(`/items/${itemId}`);
});

/** Records a borrow from someone not on Nalanda (§16 #82): only on an item not owned, one open at a time. */
loans.post('/items/:id/borrow', async (c) => {
  const itemId = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, itemId);
  if (!item) return c.notFound();
  if (item.copies > 0) return c.text('This is your own copy — nothing to record as borrowed.', 400);
  const body = await c.req.parseBody();
  const lender = String(body['lender'] ?? '').trim().slice(0, 200);
  if (lender) {
    const recorded = await borrowIfNotOwned(c.env.DB, {
      itemId,
      lender,
      borrowedOn: todayOf(c), // the device's day (§16 #69)
      contact: String(body['contact'] ?? '').trim().slice(0, 200) || null,
      dueOn: isIsoDate(String(body['dueOn'] ?? '').trim()) ? String(body['dueOn']).trim() : null,
      note: String(body['note'] ?? '').trim().slice(0, 500) || null,
    });
    if (!recorded) return c.text('Already recorded as borrowed — mark it returned first.', 409);
  }
  return c.redirect(`/items/${itemId}`);
});

loans.post('/borrows/:id/return', async (c) => {
  await returnBorrow(c.env.DB, Number(c.req.param('id')), todayOf(c));
  const referer = c.req.header('referer');
  const back = referer && URL.canParse(referer) && new URL(referer).origin === new URL(c.req.url).origin ? referer : '/borrowed';
  return c.redirect(back);
});

loans.post('/loans/:id/return', async (c) => {
  await returnLoan(c.env.DB, Number(c.req.param('id')), todayOf(c));
  const referer = c.req.header('referer');
  // back where the return was pressed — only on this origin, and a Referer that isn't a URL just means /loans
  const back = referer && URL.canParse(referer) && new URL(referer).origin === new URL(c.req.url).origin ? referer : '/loans';
  return c.redirect(back);
});

export default loans;
