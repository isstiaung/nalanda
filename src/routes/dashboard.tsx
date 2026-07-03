import { Hono } from 'hono';
import { activeLoans, listLibraries, recentItems } from '../db/queries';
import type { AppEnv } from '../env';
import { ItemGrid } from '../views/components';
import { page } from '../views/layout';

const dashboard = new Hono<AppEnv>();

dashboard.get('/', async (c) => {
  const [libraries, recent, loans] = await Promise.all([
    listLibraries(c.env.DB),
    recentItems(c.env.DB, 12),
    activeLoans(c.env.DB),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = loans.filter((l) => l.dueOn && l.dueOn < today).length;

  return page(
    c,
    'Home',
    <>
      <form method="get" action="/search" role="search">
        <input type="search" name="q" placeholder="Search your whole collection…" aria-label="Search" />
      </form>

      <section>
        <h2>Libraries</h2>
        <div class="library-list">
          {libraries.map((l) => (
            <a href={`/libraries/${l.id}`} class="library-card">
              <strong>{l.name}</strong>
              <small class="muted">
                {l.itemCount} {l.itemCount === 1 ? 'item' : 'items'}
                {l.shareToken ? ' · shared' : ''}
              </small>
            </a>
          ))}
        </div>
        <details>
          <summary>New library</summary>
          <form method="post" action="/libraries" class="inline-form">
            <input name="name" placeholder="e.g. Wishlist" required />
            <button type="submit">Create</button>
          </form>
        </details>
      </section>

      {loans.length ? (
        <section>
          <h2>
            On loan <small class="muted">({loans.length} out{overdue ? `, ${overdue} overdue` : ''})</small>
          </h2>
          <p>
            <a href="/loans">Manage loans →</a>
          </p>
        </section>
      ) : null}

      <section>
        <h2>Recently added</h2>
        {recent.length ? <ItemGrid items={recent} /> : <p class="muted">Nothing yet — hit “Add” and scan your first barcode.</p>}
      </section>
    </>,
  );
});

export default dashboard;
