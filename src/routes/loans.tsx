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
      <h1>Loans</h1>
      <section>
        <h2>Out now</h2>
        {active.length ? (
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Borrower</th>
                <th>Since</th>
                <th>Due</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {active.map((l) => (
                <tr>
                  <td>
                    <a href={`/items/${l.itemId}`}>{l.itemTitle}</a>
                  </td>
                  <td>
                    {l.borrower}
                    {l.contact ? <small class="muted"> · {l.contact}</small> : null}
                  </td>
                  <td>{l.loanedOn}</td>
                  <td class={l.dueOn && l.dueOn < today ? 'error' : undefined}>
                    {l.dueOn ?? '—'}
                    {l.dueOn && l.dueOn < today ? ' (overdue)' : ''}
                  </td>
                  <td>
                    <form method="post" action={`/loans/${l.id}/return`}>
                      <button type="submit" class="secondary slim">
                        Returned
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="muted">Nothing is out on loan.</p>
        )}
      </section>
      <section>
        <h2>History</h2>
        {history.length ? (
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Borrower</th>
                <th>Lent</th>
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
                  <td>{l.loanedOn}</td>
                  <td>{l.returnedOn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="muted">No loan history yet.</p>
        )}
      </section>
    </>,
  );
});

loans.post('/items/:id/loan', async (c) => {
  const itemId = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, itemId);
  if (!item) return c.notFound();
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
