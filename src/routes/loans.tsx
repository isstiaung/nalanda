import { Hono } from 'hono';
import { activeLoans, createLoan, getItem, loanHistory, returnLoan } from '../db/queries';
import type { AppEnv } from '../env';
import { page } from '../views/layout';

const loans = new Hono<AppEnv>();

loans.get('/loans', async (c) => {
  const [active, history] = await Promise.all([activeLoans(c.env.DB), loanHistory(c.env.DB, 100)]);
  const today = new Date().toISOString().slice(0, 10);

  return page(
    c,
    'Loans',
    <>
      <div class="page-head">
        <div>
          <h1>Loans</h1>
          <span class="sub">
            {active.length} OUT · {history.length} RETURNED
          </span>
        </div>
      </div>

      <section>
        <p class="eyebrow">Out now</p>
        {active.length ? (
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Borrower</th>
                  <th class="hide-sm">Since</th>
                  <th>Due</th>
                  <th class="actions-cell"></th>
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
                      <td>
                        {l.borrower}
                        {l.contact ? <small class="muted"> · {l.contact}</small> : null}
                      </td>
                      <td class="date hide-sm">{l.loanedOn}</td>
                      <td class="date">
                        {overdue ? <span class="pill overdue">Overdue</span> : (l.dueOn ?? '—')}
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
        <p class="eyebrow">History</p>
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
    await createLoan(c.env.DB, {
      itemId,
      borrower,
      contact: String(body['contact'] ?? '').trim() || null,
      dueOn: String(body['dueOn'] ?? '').trim() || null,
    });
  }
  return c.redirect(`/items/${itemId}`);
});

loans.post('/loans/:id/return', async (c) => {
  await returnLoan(c.env.DB, Number(c.req.param('id')));
  const referer = c.req.header('referer');
  return c.redirect(referer && new URL(referer).origin === new URL(c.req.url).origin ? referer : '/loans');
});

export default loans;
