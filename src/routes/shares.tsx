// Everything published to the open web, on one page. Share links are the only
// way data leaves this app, so "what is public right now" deserves a screen of
// its own rather than a <details> tucked inside each shelf's settings.
import { Hono } from 'hono';
import {
  countMatchingItemsMany,
  createShare,
  deleteShare,
  getLibrary,
  getSiteSettings,
  getUserById,
  listLibraries,
  listPeople,
  listShares,
  rotateShare,
  updateSiteSettings,
} from '../db/queries';
import { ITEM_STATUSES, MEDIA_TYPES, type ItemStatus, type MediaType } from '../db/schema';
import type { AppEnv } from '../env';
import { giftListStamp } from '../lib/auth';
import { isWantListShare, newShareToken, shareFilters } from '../lib/share';
import { shareScopeLabel } from '../views/components';
import { page } from '../views/layout';
import { ledgerDate } from '../lib/dates';

/** What a share link's QR image shows until /qr.js draws it: a blank palm-leaf square, nothing fetched. */
const QR_BLANK = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%23f6f2e7'/%3E%3C/svg%3E";

const shares = new Hono<AppEnv>();

shares.get('/shares', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') return c.text('Admins only', 403);

  const [views, libraries, settings] = await Promise.all([listShares(c.env.DB), listLibraries(c.env.DB), getSiteSettings(c.env.DB)]);
  const shelfName = new Map(libraries.map((l) => [l.id, l.name]));
  // whose want list a gift list is — usernames, on this admin-only page inside the app, never on the public one; asked
  // for only when there is a gift list to name
  const people = views.some(isWantListShare) ? await listPeople(c.env.DB) : [];
  const username = new Map(people.map((p) => [p.id, p.username]));
  const origin = new URL(c.req.url).origin;

  // One count per link — the same filters the public page applies, so the number is exactly how many items
  // that URL exposes — all in one batched D1 call, however many links there are.
  const counts = await countMatchingItemsMany(
    c.env.DB,
    views.map((v) => ({ libraryId: v.libraryId, filters: shareFilters(v) })),
  );
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
            {/* a sum of each link's count: an item two links show is counted twice */}
            {views.length > 1 ? ', COUNTED PER LINK' : ''}
          </span>
        </div>
      </div>

      {views.length === 0 ? (
        <p class="muted">
          Nothing is published. To share a slice of the catalogue, open a shelf, filter it to what you
          want public, and use <strong>Publish current view</strong> under Shelf settings — or open a
          tag and use <strong>Publish this tag</strong>, or a member's <a href="/wants">want list</a> and use{' '}
          <strong>Publish as a gift list</strong>. Each link gets its own unguessable URL that you
          can rotate or remove independently.
        </p>
      ) : (
        <>
          <div class="data-table cards">
            <table>
              <thead>
                <tr>
                  <th>Link</th>
                  <th class="hide-sm">Shelf</th>
                  <th>Scope</th>
                  <th class="num">Items</th>
                  <th class="hide-sm">Published</th>
                  <th><span class="sr-only">Actions</span></th>
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
                      {/* its QR code (§16 #85), drawn by /qr.js from the address above — nothing else is published */}
                      <div class="share-qr">
                        <img data-qr={`${origin}/share/${v.token}`} alt={`QR code for ${v.name}`} width="512" height="512" src={QR_BLANK} />
                        <button type="button" data-qr-download={`nalanda-${v.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'share'}.png`} class="btn" hidden>
                          Download PNG
                        </button>
                      </div>
                    </td>
                    <td class="hide-sm" data-label="Shelf">
                      {v.wantUserId !== null ? (
                        <a href={`/wants?member=${v.wantUserId}`}>Want list</a>
                      ) : v.libraryId === null ? (
                        <span class="muted">All shelves</span>
                      ) : (
                        <a href={`/libraries/${v.libraryId}`}>{shelfName.get(v.libraryId) ?? '—'}</a>
                      )}
                    </td>
                    <td data-label="Scope">
                      <span class="pill">{shareScopeLabel(v, v.wantUserId !== null ? username.get(v.wantUserId) : undefined)}</span>
                    </td>
                    <td class="num" data-label="Items">
                      {counts[i] ?? 0}
                    </td>
                    <td class="date hide-sm" data-label="Published">
                      {ledgerDate(v.createdAt)}
                    </td>
                    <td class="actions-cell">
                      {/* onclick, not onsubmit: two buttons in one form, each with its own warning */}
                      <form method="post" action={`/shares/${v.id}`} class="inline-form">
                        <button
                          name="action"
                          value="rotate"
                          class="btn"
                          data-confirm={`Rotate “${v.name}”? Its current URL stops working — anyone you gave it to needs the new one.`}
                        >
                          Rotate
                        </button>
                        <button
                          name="action"
                          value="delete"
                          class="btn-danger"
                          data-confirm={`Remove “${v.name}”? The URL stops working. The items themselves are untouched.`}
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
            Public pages show only whitelisted fields — never private notes, loans and borrowers, copy
            counts, or when you read a book, and never a link back into this app. A book finished more
            than once says how many times. Reading progress stays off them unless you turn it on below. A gift
            list shows only what its member wants now — titles, covers and the links pasted under “Where to buy” —
            and is titled “A want list” unless names are on below. Rotating a link issues a new token and kills the old URL; an already-cached
            page can survive up to an hour.
          </p>
        </>
      )}

      <section class="settings-section">
        <p class="eyebrow">Reading progress on share pages</p>
        <form method="post" action="/shares/settings" class="switch-form">
          <input type="hidden" name="setting" value="progress" />
          <label>
            <input type="checkbox" name="progressOnShares" value="on" checked={settings.progressOnShares} /> Show how far
            through a book you are
          </label>
          <p class="muted">
            Off by default. When on, a book being read now — marked <em>In progress</em>, or finished before and being
            read again — shows its current page and a progress bar on its share page; finished and unstarted books never
            do. This applies to public share links only. A page someone already loaded can take up to an hour to catch
            up.
          </p>
          <button type="submit">Save</button>
        </form>
      </section>

      <section class="settings-section" id="names-on-shares">
        <p class="eyebrow">Names on share pages</p>
        <form method="post" action="/shares/settings" class="switch-form">
          <input type="hidden" name="setting" value="names" />
          <label>
            <input type="checkbox" name="namesOnShares" value="on" checked={settings.namesOnShares} /> Show each member's rating
            and review, with their display name
          </label>
          <p class="muted">
            Off, a shared book shows the household's average rating and its latest review, unsigned. On, it also lists
            everyone's rating and review, each signed with the member's <strong>display name</strong> — set on their
            Account page, or by an admin under <a href="/settings/users">Members</a>. A member without one appears as “A
            member”. Login usernames never appear, and nor does who read what or when: reading history stays “Read N
            times”. Turning it off hides names from every page served after; a page someone already loaded can take up to
            an hour to catch up.
          </p>
          <button type="submit">Save</button>
        </form>
      </section>
      <script src="/vendor/qrcode.js" defer></script>
      <script src="/qr.js" defer></script>
    </>,
    libraries, // the sidebar's list too (§16 #68)
  );
});

shares.post('/shares/settings', async (c) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  const body = await c.req.parseBody();
  // an unchecked checkbox sends nothing at all, so absence means off — for the setting its form names, and only that
  await updateSiteSettings(
    c.env.DB,
    body['setting'] === 'names' ? { namesOnShares: body['namesOnShares'] === 'on' } : { progressOnShares: body['progressOnShares'] === 'on' },
  );
  return c.redirect('/shares'); // a successful POST also clears this isolate's share-page cache (index.ts)
});

shares.post('/shares', async (c) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  const body = await c.req.parseBody();
  const str = (k: string) => {
    const v = body[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  // A gift list (§16 #53): one member's want list as it stands, published from their want-list page. It captures
  // nothing but the member — no shelf, no filters, no sort but title — and has no name of its own to show: its public
  // title is worked out when served, with a display name only while names are on for share pages.
  if (str('wantUserId')) {
    const raw = str('wantUserId');
    const member = /^\d{1,15}$/.test(raw) ? await getUserById(c.env.DB, Number(raw)) : null;
    // A user id is reused once the newest member is removed (§16 #56), so a form left open from before could name
    // someone else: it carries a stamp of the account it was made for, which must still be this one's.
    const stamp = member && c.env.SESSION_SECRET ? await giftListStamp(c.env.SESSION_SECRET, member) : null;
    if (!member || !stamp || stamp !== str('wantStamp')) return c.text('No such member — reload their want list and publish again.', 400);
    await createShare(c.env.DB, { token: newShareToken(), name: 'Want list', libraryId: null, wantUserId: member.id, sort: 'title' });
    return c.redirect(`/wants?member=${member.id}`);
  }
  // Published from a shelf (its current filters) or from a tag's page (everything carrying the tag, on any
  // shelf). Tags are stored lowercase.
  const tag = str('tag').toLowerCase();
  const libraryId = Number.parseInt(str('libraryId'), 10);
  const lib = Number.isInteger(libraryId) ? await getLibrary(c.env.DB, libraryId) : null;
  if (!lib && !tag) return c.text('No such shelf.', 400);
  const name = str('name') || lib?.name || tag;
  await createShare(c.env.DB, {
    token: newShareToken(),
    name,
    libraryId: lib?.id ?? null,
    tag: tag || null,
    mediaType: (MEDIA_TYPES as readonly string[]).includes(str('mediaType')) ? (str('mediaType') as MediaType) : null,
    status: (ITEM_STATUSES as readonly string[]).includes(str('status')) ? (str('status') as ItemStatus) : null,
    owned: str('owned') === '1' ? true : str('owned') === '0' ? false : null,
    sort:
      str('sort') === 'added' || str('sort') === 'author' || str('sort') === 'rating' || str('sort') === 'completed'
        ? (str('sort') as 'added' | 'author' | 'rating' | 'completed')
        : 'title',
  });
  return c.redirect(lib ? `/libraries/${lib.id}` : `/tags/${encodeURIComponent(tag)}`);
});

shares.post('/shares/:id', async (c) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const action = String(body['action'] ?? '');
  if (action === 'rotate') await rotateShare(c.env.DB, id, newShareToken());
  else if (action === 'delete') await deleteShare(c.env.DB, id);
  // Posted from a shelf's settings panel, a tag's page, a want list, or /shares with none of them in hand.
  const back = Number.parseInt(String(body['libraryId'] ?? ''), 10);
  const backTag = typeof body['tag'] === 'string' ? body['tag'] : '';
  const backWant = Number.parseInt(String(body['wantUserId'] ?? ''), 10);
  if (Number.isInteger(back)) return c.redirect(`/libraries/${back}`);
  if (Number.isInteger(backWant)) return c.redirect(`/wants?member=${backWant}`);
  return c.redirect(backTag ? `/tags/${encodeURIComponent(backTag)}` : '/shares');
});

export default shares;
