// Everything published to the open web, on one page. Share links are the only
// way data leaves this app, so "what is public right now" deserves a screen of
// its own rather than a <details> tucked inside each shelf's settings.
import { Hono } from 'hono';
import {
  countMatchingItems,
  createShare,
  deleteShare,
  getLibrary,
  listLibraries,
  listShares,
  rotateShare,
} from '../db/queries';
import { ITEM_STATUSES, MEDIA_TYPES, type ItemStatus, type MediaType } from '../db/schema';
import type { AppEnv } from '../env';
import { newShareToken, shareFilters } from '../lib/share';
import { shareScopeLabel } from '../views/components';
import { page } from '../views/layout';

const shares = new Hono<AppEnv>();

shares.get('/shares', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') return c.text('Admins only', 403);

  const [views, libraries] = await Promise.all([listShares(c.env.DB), listLibraries(c.env.DB)]);
  const shelfName = new Map(libraries.map((l) => [l.id, l.name]));
  const origin = new URL(c.req.url).origin;

  // One count per link — the same filters the public page applies, so the number
  // is exactly how many items that URL exposes.
  const counts = await Promise.all(views.map((v) => countMatchingItems(c.env.DB, v.libraryId, shareFilters(v))));
  const exposed = views.reduce((n, _v, i) => n + (counts[i] ?? 0), 0);

  return page(
    c,
    'Shared links',
    <>
      <div class="page-head">
        <div>
          <h1>Shared links</h1>
          <span class="sub">
            {views.length} {views.length === 1 ? 'LINK' : 'LINKS'} · {exposed}{' '}
            {exposed === 1 ? 'ITEM' : 'ITEMS'} PUBLIC
          </span>
        </div>
      </div>

      {views.length === 0 ? (
        <p class="muted">
          Nothing is published. To share a slice of the catalogue, open a shelf, filter it to what you
          want public, and use <strong>Publish current view</strong> under Shelf settings. Each link
          gets its own unguessable URL that you can rotate or remove independently.
        </p>
      ) : (
        <>
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>Link</th>
                  <th class="hide-sm">Shelf</th>
                  <th>Scope</th>
                  <th class="num">Items</th>
                  <th class="hide-sm">Published</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {views.map((v, i) => (
                  <tr>
                    <td>
                      <strong>{v.name}</strong>
                      <br />
                      <a href={`${origin}/share/${v.token}`} class="mono break-anywhere">
                        {origin}/share/{v.token}
                      </a>
                    </td>
                    <td class="hide-sm">
                      {v.libraryId === null ? (
                        <span class="muted">All shelves</span>
                      ) : (
                        <a href={`/libraries/${v.libraryId}`}>{shelfName.get(v.libraryId) ?? '—'}</a>
                      )}
                    </td>
                    <td>
                      <span class="pill">{shareScopeLabel(v)}</span>
                    </td>
                    <td class="num">{counts[i] ?? 0}</td>
                    <td class="date hide-sm">{v.createdAt.slice(0, 10)}</td>
                    <td class="actions-cell">
                      {/* onclick, not onsubmit: two buttons in one form, each with its own warning */}
                      <form method="post" action={`/shares/${v.id}`} class="inline-form">
                        <button
                          name="action"
                          value="rotate"
                          class="btn"
                          onclick={`return confirm('Rotate “${v.name}”? Its current URL stops working — anyone you gave it to needs the new one.')`}
                        >
                          Rotate
                        </button>
                        <button
                          name="action"
                          value="delete"
                          class="btn-danger"
                          onclick={`return confirm('Remove “${v.name}”? The URL stops working. The items themselves are untouched.')`}
                        >
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="muted">
            Public pages show only whitelisted fields — never private notes, loans and borrowers, or
            copy counts, and never a link back into this app. Rotating a link issues a new token and
            kills the old URL; an already-cached page can survive up to an hour.
          </p>
        </>
      )}
    </>,
  );
});

shares.post('/shares', async (c) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  const body = await c.req.parseBody();
  const str = (k: string) => {
    const v = body[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const libraryId = Number.parseInt(str('libraryId'), 10);
  const lib = Number.isInteger(libraryId) ? await getLibrary(c.env.DB, libraryId) : null;
  if (!lib) return c.text('No such shelf.', 400);
  const name = str('name') || lib.name;
  await createShare(c.env.DB, {
    token: newShareToken(),
    name,
    libraryId,
    mediaType: (MEDIA_TYPES as readonly string[]).includes(str('mediaType')) ? (str('mediaType') as MediaType) : null,
    status: (ITEM_STATUSES as readonly string[]).includes(str('status')) ? (str('status') as ItemStatus) : null,
    owned: str('owned') === '1' ? true : str('owned') === '0' ? false : null,
    sort:
      str('sort') === 'added' || str('sort') === 'rating' || str('sort') === 'completed'
        ? (str('sort') as 'added' | 'rating' | 'completed')
        : 'title',
  });
  return c.redirect(`/libraries/${libraryId}`);
});

shares.post('/shares/:id', async (c) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const action = String(body['action'] ?? '');
  if (action === 'rotate') await rotateShare(c.env.DB, id, newShareToken());
  else if (action === 'delete') await deleteShare(c.env.DB, id);
  // Posted from a shelf's settings panel, or from /shares with no shelf in hand.
  const back = Number.parseInt(String(body['libraryId'] ?? ''), 10);
  return c.redirect(Number.isInteger(back) ? `/libraries/${back}` : '/shares');
});

export default shares;
