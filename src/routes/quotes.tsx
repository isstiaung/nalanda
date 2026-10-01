// A member's quotes (ARCH.md §16 #77): everything they have copied down or highlighted, newest first, each under the
// book it is from. Inside the app only: a share page shows an item's shared quotes, nothing of this page.
import { Hono } from 'hono';
import { listPeople, quotesOf, QUOTES_PER_PAGE } from '../db/queries';
import type { AppEnv } from '../env';
import { ledgerDate } from '../lib/dates';
import { Cover } from '../views/components';
import { page } from '../views/layout';

const quotes = new Hono<AppEnv>();

quotes.get('/quotes', async (c) => {
  const user = c.get('user');
  const people = await listPeople(c.env.DB);
  const raw = c.req.query('member') ?? '';
  const asked = /^\d{1,15}$/.test(raw) ? Number(raw) : user.id;
  const member = people.find((p) => p.id === asked) ?? people.find((p) => p.id === user.id)!;
  const mine = member.id === user.id;
  const pageNum = Number.parseInt(c.req.query('page') ?? '1', 10) || 1;
  const { quotes: list, more } = await quotesOf(c.env.DB, member.id, pageNum);
  const here = (p: number) => `/quotes?${new URLSearchParams({ ...(mine ? {} : { member: String(member.id) }), page: String(p) })}`;
  const title = mine ? 'Your quotes' : `${member.username}’s quotes`;
  return page(
    c,
    title,
    <>
      <div class="page-head">
        <div>
          <h1>{title}</h1>
          <span class="sub">NEWEST FIRST{pageNum > 1 ? ` · PAGE ${pageNum}` : ''}</span>
        </div>
        {people.length > 1 ? (
          <form method="get" action="/quotes" class="inline-form">
            <select name="member" aria-label="Whose quotes">
              {people.map((p) => (
                <option value={String(p.id)} selected={p.id === member.id}>
                  {p.id === user.id ? `${p.username} (you)` : p.username}
                </option>
              ))}
            </select>
            <button type="submit" class="btn">
              Show
            </button>
          </form>
        ) : null}
      </div>
      {list.length ? (
        <ol class="quotes quotes-page">
          {list.map((q) => (
            <li class={q.shared ? 'quote shared' : 'quote'}>
              <a href={`/items/${q.itemId}#quotes`} class="quote-book">
                <span class="quote-cover">
                  <Cover coverKey={q.coverKey} title={q.title} mediaType={q.mediaType} />
                </span>
                <span>
                  <strong>{q.title}</strong>
                  {q.creators ? <small class="muted"> · {q.creators}</small> : null}
                </span>
              </a>
              <blockquote class="quote-text prewrap">{q.text}</blockquote>
              <p class="quote-by">
                {q.page ? <span class="mono muted">{q.page}</span> : null}
                <span class="mono muted">{ledgerDate(q.at)}</span>
                {q.source === 'kindle' ? <span class="pill ghost">Kindle</span> : null}
                {q.shared ? <span class="pill">Shared</span> : null}
              </p>
              {q.note ? <p class="quote-note prewrap">{q.note}</p> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p class="muted">
          {mine ? 'No quotes yet. Add one from any book’s page, or import your Kindle highlights under Import / export.' : 'No quotes.'}
        </p>
      )}
      {pageNum > 1 || more ? (
        <nav class="pagination" aria-label="Pages">
          {pageNum > 1 ? <a href={here(pageNum - 1)}>← Newer</a> : null}
          {more ? <a href={here(pageNum + 1)}>Older ({QUOTES_PER_PAGE} a page) →</a> : null}
        </nav>
      ) : null}
    </>,
  );
});

export default quotes;
