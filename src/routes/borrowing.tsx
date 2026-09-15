// Borrowing between connected households (docs/proposals/connections.md §7, §10): browsing a connection's
// shared shelves, asking to borrow, answering requests on the Loans page, and the Borrowed page.
//
// Shelves are read from the other household when a page opens and kept in this isolate's memory for a few
// minutes — never stored. Everything they send is untrusted: validated, rendered as escaped text, and covers
// load only from their own /covers/<uuid>.
import { Hono, type Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import {
  availability,
  deleteBorrowed,
  federationExport,
  getBorrowRequest,
  getConnection,
  getFederationSettings,
  hasPendingOutgoing,
  insertBorrowRequest,
  lendToConnection,
  listBorrowed,
  listConnections,
  pendingIncoming,
  recentOutgoing,
  setRequestStatus,
} from '../db/federation';
import type { BorrowStatus, Connection, FederationSettings } from '../db/schema';
import type { AppEnv } from '../env';
import { refreshInBackground } from '../federation/background';
import { MAX_BORROW_NOTE_CHARS, SHELF_CACHE_ENTRIES, SHELF_CACHE_MS } from '../federation/config';
import { parseSharedViews } from '../federation/feed';
import { getSigned } from '../federation/http';
import { coverUrl, isId, parseItemDetail, parseShelfItem, type ShelfItem } from '../federation/items';
import { loadIdentity, type Identity } from '../federation/keys';
import { borrowAccept, borrowDecline, borrowRequest, borrowWithdraw } from '../federation/messages';
import { sendNow, sendToConnection } from '../federation/outbox';
import { DetailsList, MEDIA_ICON, MEDIA_LABEL, Pagination, stars } from '../views/components';
import { page } from '../views/layout';

const borrowing = new Hono<AppEnv>();

type Enabled = { identity: Identity; settings: FederationSettings };

async function enabled(c: Context<AppEnv>): Promise<Enabled | null> {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return null;
  const settings = await getFederationSettings(c.env.DB);
  return settings ? { identity, settings } : null;
}

const digits = (raw: unknown) => (typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : null);
const today = () => new Date().toISOString().slice(0, 10);

/** Pulls connections' outboxes and retries our undelivered pushes, after the response and within its query budget. */
function refreshAfterResponse(c: Context<AppEnv>, ctx: Enabled) {
  refreshInBackground(c, ctx.identity, ctx.settings, false);
}

// ---------- reading a connection's shelves ----------

const shelfCache = new Map<string, { value: unknown; expires: number }>();

/**
 * A signed GET to a connection, read through `parse` and kept in this isolate's memory for SHELF_CACHE_MS.
 * Shelves are read live and never stored (§7). Only an answer that validated is kept — never a raw body, and
 * never a failure, so a household that recovers is seen at once.
 */
async function readFromHousehold<T>(
  ctx: Enabled,
  connection: Connection,
  path: string,
  parse: (body: unknown) => T | null,
): Promise<{ status: number | null; value: T | null }> {
  const key = `${connection.id}|${connection.baseUrl}|${path}`;
  const hit = shelfCache.get(key);
  if (hit && hit.expires > Date.now()) return { status: 200, value: hit.value as T };
  shelfCache.delete(key);
  const res = await getSigned(ctx.identity, ctx.settings.baseUrl, connection.baseUrl, path);
  const value = res?.status === 200 ? parse(res.body) : null;
  if (value !== null) {
    if (shelfCache.size >= SHELF_CACHE_ENTRIES) {
      const oldest = shelfCache.keys().next().value;
      if (oldest !== undefined) shelfCache.delete(oldest);
    }
    shelfCache.set(key, { value, expires: Date.now() + SHELF_CACHE_MS });
  }
  return { status: res?.status ?? null, value };
}

async function household(c: Context<AppEnv>): Promise<Connection | null> {
  const row = await getConnection(c.env.DB, Number(c.req.param('id')));
  return row?.status === 'active' ? row : null;
}

type Shelf = { name: string; total: number; page: number; pages: number; items: ShelfItem[] };

function parseShelf(value: unknown): Shelf | null {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const view = v?.view && typeof v.view === 'object' ? (v.view as Record<string, unknown>) : null;
  if (!v || !view || typeof view.name !== 'string' || view.name.length > 80 || !Array.isArray(v.items)) return null;
  const count = (n: unknown) => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : null);
  const total = count(v.total);
  const current = count(v.page);
  const pages = count(v.pages);
  if (total === null || !current || !pages) return null;
  const items = v.items.slice(0, 100).map(parseShelfItem).filter((item): item is ShelfItem => item !== null);
  return { name: view.name, total, page: current, pages, items };
}

const TheirCover: FC<{ baseUrl: string; coverKey: string | null; title: string; mediaType: ShelfItem['mediaType'] }> = (p) => {
  const url = coverUrl(p.baseUrl, p.coverKey);
  return url ? (
    <img class="cover-img" src={url} alt={`Cover of ${p.title}`} loading="lazy" referrerpolicy="no-referrer" />
  ) : (
    <div class="cover-fallback" aria-hidden="true">
      {MEDIA_ICON[p.mediaType]}
    </div>
  );
};

const Unreachable: FC<{ connection: Connection }> = ({ connection }) => (
  <p class="muted">Couldn’t reach {connection.householdName} just now. Their library may be offline — try again later.</p>
);

/** The shelves a household shares. */
borrowing.get('/households/:id', async (c) => {
  const ctx = await enabled(c);
  const connection = ctx ? await household(c) : null;
  if (!ctx || !connection) return c.notFound();
  const { value: views } = await readFromHousehold(ctx, connection, '/federation/views', parseSharedViews);
  return page(
    c,
    connection.householdName,
    <>
      <div class="page-head">
        <div>
          <h1>{connection.householdName}</h1>
          <span class="sub">SHARED SHELVES</span>
        </div>
      </div>
      {views === null ? (
        <Unreachable connection={connection} />
      ) : views.length === 0 ? (
        <p class="muted">{connection.householdName} isn’t sharing any shelves.</p>
      ) : (
        <ul class="household-list">
          {views.map((v) => (
            <li>
              <a href={`/households/${connection.id}/views/${v.id}`}>{v.name}</a>
              <small class="muted">{v.itemCount} items</small>
            </li>
          ))}
        </ul>
      )}
      <p class="back-link">
        <a href="/borrowed">← Borrowed</a>
      </p>
    </>,
  );
});

/** One page of a shared shelf, read live. */
borrowing.get('/households/:id/views/:viewId', async (c) => {
  const ctx = await enabled(c);
  const connection = ctx ? await household(c) : null;
  const viewId = digits(c.req.param('viewId'));
  if (!ctx || !connection || !viewId) return c.notFound();
  const pageNum = digits(c.req.query('page')) ?? 1;
  const { status, value: shelf } = await readFromHousehold(ctx, connection, `/federation/shelf?view=${viewId}&page=${pageNum}`, parseShelf);
  const base = `/households/${connection.id}/views/${viewId}`;
  return page(
    c,
    shelf ? `${shelf.name} · ${connection.householdName}` : connection.householdName,
    <>
      <div class="page-head">
        <div>
          <h1>{shelf?.name ?? connection.householdName}</h1>
          <span class="sub">
            {connection.householdName.toUpperCase()}
            {shelf ? ` · ${shelf.total} ${shelf.total === 1 ? 'ITEM' : 'ITEMS'}` : ''}
          </span>
        </div>
      </div>
      {status === 404 ? (
        <p class="muted">{connection.householdName} no longer shares this shelf.</p>
      ) : !shelf ? (
        <Unreachable connection={connection} />
      ) : (
        <>
          <div class="item-grid">
            {shelf.items.map((item) => (
              <a href={`${base}/items/${item.id}`} class="item-card">
                <div class="item-cover">
                  <TheirCover baseUrl={connection.baseUrl} coverKey={item.coverKey} title={item.title} mediaType={item.mediaType} />
                </div>
                <div class="item-meta">
                  <strong>{item.title}</strong>
                  {item.creators ? <small>{item.creators}</small> : null}
                  <span class="mline">
                    {item.rating ? <span class="rating">{stars(item.rating)}</span> : null}
                    {item.available ? (
                      <span class="pill done">Available</span>
                    ) : item.inCollection ? (
                      <span class="pill lent">Out</span>
                    ) : (
                      <span class="pill ghost">Not owned</span>
                    )}
                  </span>
                </div>
              </a>
            ))}
          </div>
          <Pagination page={shelf.page} pages={shelf.pages} makeHref={(p) => `${base}?page=${p}`} />
        </>
      )}
      <p class="back-link">
        <a href={`/households/${connection.id}`}>← {connection.householdName}</a>
      </p>
    </>,
  );
});

/** One of their books, read live, with a request form while a copy is free. */
borrowing.get('/households/:id/views/:viewId/items/:itemId', async (c) => {
  const ctx = await enabled(c);
  const connection = ctx ? await household(c) : null;
  const viewId = digits(c.req.param('viewId'));
  const itemId = digits(c.req.param('itemId'));
  if (!ctx || !connection || !viewId || !itemId) return c.notFound();
  const { status, value: item } = await readFromHousehold(ctx, connection, `/federation/item?view=${viewId}&id=${itemId}`, parseItemDetail);
  const back = `/households/${connection.id}/views/${viewId}`;
  if (!item) {
    return page(
      c,
      connection.householdName,
      <>
        {status === 404 ? <p class="muted">That book isn’t on a shelf they share any more.</p> : <Unreachable connection={connection} />}
        <p class="back-link">
          <a href={back}>← back</a>
        </p>
      </>,
    );
  }
  const asked = await hasPendingOutgoing(c.env.DB, connection.id, item.id, item.stamp);
  return page(
    c,
    `${item.title} · ${connection.householdName}`,
    <article class="item-detail">
      <div class="item-detail-cover">
        <TheirCover baseUrl={connection.baseUrl} coverKey={item.coverKey} title={item.title} mediaType={item.mediaType} />
      </div>
      <div class="item-detail-body">
        <hgroup>
          <h1>{item.title}</h1>
          {item.creators ? <p>{item.creators}</p> : null}
        </hgroup>
        {item.tags.length ? (
          <p>
            {item.tags.map((t) => (
              <span class="tag">{t}</span>
            ))}
          </p>
        ) : null}
        <dl class="props">
          <dt>From</dt>
          <dd>{connection.householdName}</dd>
          <dt>Type</dt>
          <dd>{MEDIA_LABEL[item.mediaType]}</dd>
          {item.rating ? (
            <>
              <dt>Rating</dt>
              <dd>
                <span class="rating">{stars(item.rating)}</span>
              </dd>
            </>
          ) : null}
          {item.published ? (
            <>
              <dt>Published</dt>
              <dd>{item.published}</dd>
            </>
          ) : null}
          {item.publisher ? (
            <>
              <dt>Publisher</dt>
              <dd>{item.publisher}</dd>
            </>
          ) : null}
        </dl>
        {item.description ? <p class="prewrap">{item.description}</p> : null}
        {Object.keys(item.details).length ? (
          <div class="detail-section">
            <p class="eyebrow">Details</p>
            <DetailsList details={item.details} />
          </div>
        ) : null}
        {item.review ? (
          <div class="detail-section">
            <p class="eyebrow">Their review</p>
            <p class="prewrap">{item.review}</p>
          </div>
        ) : null}
        <div class={item.available ? 'circulation free' : 'circulation'}>
          <p class="eyebrow">Borrowing</p>
          {asked ? (
            <p class="muted">You’ve asked to borrow this. It’s on your Borrowed page.</p>
          ) : item.available ? (
            <form method="post" action={`/households/${connection.id}/requests`} class="request-form">
              <input type="hidden" name="viewId" value={String(viewId)} />
              <input type="hidden" name="itemId" value={String(item.id)} />
              <textarea
                name="note"
                rows={2}
                maxlength={MAX_BORROW_NOTE_CHARS}
                placeholder="A note for them (optional)"
                aria-label="Note"
              ></textarea>
              <button type="submit">Ask to borrow</button>
            </form>
          ) : item.inCollection ? (
            <p class="muted">Every copy is out right now.</p>
          ) : (
            <p class="muted">Read, but not on their shelves — nothing to lend.</p>
          )}
        </div>
        <p class="back-link">
          <a href={back}>← back to the shelf</a>
        </p>
      </div>
    </article>,
  );
});

/** Ask to borrow: checked against their current answer, and sent at once so the member knows. */
borrowing.post('/households/:id/requests', async (c) => {
  const ctx = await enabled(c);
  const connection = ctx ? await household(c) : null;
  if (!ctx || !connection) return c.notFound();
  const form = await c.req.parseBody();
  const viewId = digits(form['viewId']);
  const itemId = digits(form['itemId']);
  const rawNote = typeof form['note'] === 'string' ? form['note'].replace(/\r\n?/g, '\n').trim() : '';
  if (!viewId || !itemId || !isId(itemId) || rawNote.length > MAX_BORROW_NOTE_CHARS) return c.redirect('/borrowed');

  // Their current word, not a cached page: the title kept, and whether a copy is still free.
  const res = await getSigned(ctx.identity, ctx.settings.baseUrl, connection.baseUrl, `/federation/item?view=${viewId}&id=${itemId}`);
  const item = res?.status === 200 ? parseItemDetail(res.body) : null;
  if (!item || !item.available) {
    return renderBorrowed(c, ctx, {
      error: item
        ? `That book isn’t available from ${connection.householdName} right now.`
        : `Couldn’t reach ${connection.householdName} to ask. Nothing was sent.`,
    });
  }
  if (await hasPendingOutgoing(c.env.DB, connection.id, item.id, item.stamp)) return c.redirect('/borrowed');

  const user = c.get('user');
  const message = borrowRequest(ctx.settings.baseUrl, item.id, item.stamp, user.username, rawNote || null);
  const row = await insertBorrowRequest(c.env.DB, {
    activityId: message.id,
    connectionId: connection.id,
    incoming: false,
    theirItemId: item.id,
    theirItemStamp: item.stamp,
    theirViewId: viewId,
    itemTitle: item.title,
    coverKey: item.coverKey,
    requesterName: message.requester,
    requesterId: user.id,
    note: message.note,
  });
  const status = await sendNow(c.env.DB, ctx.identity, ctx.settings, connection, message);
  if (row && status !== null && status >= 400 && status < 500 && status !== 429) {
    await setRequestStatus(c.env.DB, row.id, 'declined', ['pending']);
    return renderBorrowed(c, ctx, { error: `${connection.householdName} couldn’t take that request: the book isn’t available any more.` });
  }
  return c.redirect('/borrowed');
});

borrowing.post('/borrow-requests/:id/withdraw', async (c) => {
  const ctx = await enabled(c);
  if (!ctx) return c.notFound();
  const request = await getBorrowRequest(c.env.DB, Number(c.req.param('id')));
  if (!request || request.incoming) return c.redirect('/borrowed');
  const connection = await getConnection(c.env.DB, request.connectionId);
  if ((await setRequestStatus(c.env.DB, request.id, 'withdrawn', ['pending'])) && connection?.status === 'active') {
    await sendToConnection(c, ctx.identity, ctx.settings, connection, borrowWithdraw(ctx.settings.baseUrl, request.activityId));
  }
  return c.redirect('/borrowed');
});

/** Lend: an ordinary loan to "name (their library)", while a copy is still free. Any member may. */
borrowing.post('/borrow-requests/:id/accept', async (c) => {
  const ctx = await enabled(c);
  if (!ctx) return c.notFound();
  const request = await getBorrowRequest(c.env.DB, Number(c.req.param('id')));
  const connection = request ? await getConnection(c.env.DB, request.connectionId) : null;
  if (!request?.incoming || request.status !== 'pending' || connection?.status !== 'active') return c.redirect('/loans');

  const form = await c.req.parseBody();
  const dueOn = typeof form['dueOn'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(form['dueOn']) ? form['dueOn'] : null;
  const loanId = await lendToConnection(c.env.DB, request, `${request.requesterName} (${connection.householdName})`, dueOn);
  if (loanId) {
    await sendToConnection(c, ctx.identity, ctx.settings, connection, borrowAccept(ctx.settings.baseUrl, request.activityId, today(), dueOn));
  }
  return c.redirect('/loans');
});

borrowing.post('/borrow-requests/:id/decline', async (c) => {
  const ctx = await enabled(c);
  if (!ctx) return c.notFound();
  const request = await getBorrowRequest(c.env.DB, Number(c.req.param('id')));
  if (!request?.incoming) return c.redirect('/loans');
  const connection = await getConnection(c.env.DB, request.connectionId);
  if ((await setRequestStatus(c.env.DB, request.id, 'declined', ['pending'])) && connection?.status === 'active') {
    await sendToConnection(c, ctx.identity, ctx.settings, connection, borrowDecline(ctx.settings.baseUrl, request.activityId));
  }
  return c.redirect('/loans');
});

// ---------- the Borrowed page ----------

const STATUS_PILL: Record<BorrowStatus, [string, string]> = {
  pending: ['pill', 'Waiting'],
  accepted: ['pill done', 'Lent to you'],
  declined: ['pill dropped', 'Declined'],
  withdrawn: ['pill ghost', 'Withdrawn'],
};

async function renderBorrowed(c: Context<AppEnv>, ctx: Enabled, flash: { error?: string } = {}) {
  const [borrowed, requests, connections] = await Promise.all([
    listBorrowed(c.env.DB),
    recentOutgoing(c.env.DB, 30),
    listConnections(c.env.DB),
  ]);
  refreshAfterResponse(c, ctx);
  const now = borrowed.filter((b) => !b.returnedOn);
  const returned = borrowed.filter((b) => b.returnedOn);
  const households = connections.filter((row) => row.status === 'active');
  const waiting = requests.filter((r) => r.status === 'pending').length;
  const todayStr = today();

  return page(
    c,
    'Borrowed',
    <>
      <div class="page-head">
        <div>
          <h1>Borrowed</h1>
          <span class="sub">
            {now.length} FROM CONNECTIONS · {waiting} WAITING
          </span>
        </div>
      </div>
      {flash.error ? <p class="error">{flash.error}</p> : null}

      <section>
        <p class="eyebrow">Borrowed now</p>
        {now.length ? (
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>Book</th>
                  <th>From</th>
                  <th class="hide-sm">Since</th>
                  <th>Due</th>
                </tr>
              </thead>
              <tbody>
                {now.map((b) => (
                  <tr>
                    <td>
                      <strong>{b.title}</strong>
                    </td>
                    <td>{b.householdName}</td>
                    <td class="date hide-sm">{b.borrowedOn}</td>
                    <td class="date">{b.dueOn && b.dueOn < todayStr ? <span class="pill overdue">Overdue · {b.dueOn}</span> : (b.dueOn ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">Nothing borrowed from connections right now.</p>
        )}
      </section>

      <section>
        <p class="eyebrow">Your requests</p>
        {requests.length ? (
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>Book</th>
                  <th>From</th>
                  <th class="hide-sm">Asked</th>
                  <th>Status</th>
                  <th class="actions-cell"></th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr>
                    <td>
                      <strong>{r.itemTitle}</strong>
                    </td>
                    <td>{r.householdName}</td>
                    <td class="date hide-sm">{r.createdAt.slice(0, 10)}</td>
                    <td>
                      {r.returned ? (
                        <span class="pill ghost">Returned</span>
                      ) : (
                        <span class={STATUS_PILL[r.status][0]}>{STATUS_PILL[r.status][1]}</span>
                      )}
                    </td>
                    <td class="actions-cell">
                      {r.status === 'pending' ? (
                        <form method="post" action={`/borrow-requests/${r.id}/withdraw`} class="inline">
                          <button type="submit" class="btn">
                            Withdraw
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">No requests yet. Browse a connected household’s shelves below to ask for a book.</p>
        )}
      </section>

      <section>
        <p class="eyebrow">Browse connected households</p>
        {households.length ? (
          <ul class="household-list">
            {households.map((h) => (
              <li>
                <a href={`/households/${h.id}`}>{h.householdName}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">No connected households yet.</p>
        )}
      </section>

      {returned.length ? (
        <section>
          <p class="eyebrow">Returned</p>
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>Book</th>
                  <th>From</th>
                  <th>Returned</th>
                  <th class="actions-cell"></th>
                </tr>
              </thead>
              <tbody>
                {returned.map((b) => (
                  <tr>
                    <td>{b.title}</td>
                    <td>{b.householdName}</td>
                    <td class="date">{b.returnedOn}</td>
                    <td class="actions-cell">
                      <form method="post" action={`/borrowed/${b.id}/remove`} class="inline">
                        <button type="submit" class="btn">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {c.get('user').role === 'admin' ? (
        <p class="muted">
          <a href="/federation/export.json">Export connections data (JSON)</a>
        </p>
      ) : null}
    </>,
  );
}

borrowing.get('/borrowed', async (c) => {
  const ctx = await enabled(c);
  return ctx ? renderBorrowed(c, ctx) : c.notFound();
});

borrowing.post('/borrowed/:id/remove', async (c) => {
  if (!(await enabled(c))) return c.notFound();
  await deleteBorrowed(c.env.DB, Number(c.req.param('id')));
  return c.redirect('/borrowed');
});

/** Connections data as a download for admins: active connections, views, following, comments, borrowing. Never keys. */
borrowing.get('/federation/export.json', async (c) => {
  if (!(await enabled(c))) return c.notFound();
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  return c.json(await federationExport(c.env.DB), 200, {
    'content-disposition': 'attachment; filename="nalanda-connections.json"',
  });
});

/**
 * Requests from connections, for the top of the Loans page — null unless connections are enabled and someone
 * is waiting, so the page is otherwise unchanged. Opening Loans also pulls connections' outboxes.
 */
export async function loanRequestsSection(c: Context<AppEnv>): Promise<Child | null> {
  const ctx = await enabled(c);
  if (!ctx) return null;
  refreshAfterResponse(c, ctx);
  const requests = await pendingIncoming(c.env.DB);
  if (!requests.length) return null;
  const free = await availability(
    c.env.DB,
    requests.map((r) => r.item),
  );
  return (
    <section>
      <p class="eyebrow">Requests from connections</p>
      <div class="data-table">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>From</th>
              <th class="hide-sm">Asked</th>
              <th class="actions-cell"></th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr>
                <td>
                  <a href={`/items/${r.item.id}`}>
                    <strong>{r.item.title}</strong>
                  </a>
                  {r.note ? (
                    <>
                      <br />
                      <small class="prewrap">{r.note}</small>
                    </>
                  ) : null}
                </td>
                <td>
                  {r.requesterName}
                  <small class="muted"> · {r.householdName}</small>
                </td>
                <td class="date hide-sm">{r.createdAt.slice(0, 10)}</td>
                <td class="actions-cell">
                  <div class="request-actions">
                    {free.get(r.item.id) ? (
                      <form method="post" action={`/borrow-requests/${r.id}/accept`} class="inline-form">
                        <input type="date" name="dueOn" aria-label="Due date" />
                        <button type="submit" class="btn">
                          Lend
                        </button>
                      </form>
                    ) : (
                      <small class="muted">No copy free</small>
                    )}
                    <form method="post" action={`/borrow-requests/${r.id}/decline`} class="inline">
                      <button type="submit" class="btn-danger">
                        Decline
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default borrowing;
