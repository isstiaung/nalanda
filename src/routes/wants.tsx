// Want lists (ARCH.md §16 #53): each member's own list of what they want to read — or, for a record or a game, want —
// visible to the household inside the app, and publishable by an admin as a gift list (a want-list share).
import { Hono } from 'hono';
import { getUserById, listItems, listPeople, listWantShares, wantListExtras } from '../db/queries';
import type { AppEnv } from '../env';
import { giftListStamp } from '../lib/auth';
import { BuyLinks, Cover, MEDIA_LABEL, NotOwnedPill, Pagination, wantLabel } from '../views/components';
import { page } from '../views/layout';

const wants = new Hono<AppEnv>();

wants.get('/wants', async (c) => {
  const user = c.get('user');
  const admin = user.role === 'admin';
  const people = await listPeople(c.env.DB);
  const raw = c.req.query('member') ?? '';
  const asked = /^\d{1,15}$/.test(raw) ? Number(raw) : user.id;
  const member = people.find((p) => p.id === asked) ?? people.find((p) => p.id === user.id)!;
  const mine = member.id === user.id;
  const pageNum = Number.parseInt(c.req.query('page') ?? '1', 10) || 1;

  const [list, shares, account] = await Promise.all([
    listItems(c.env.DB, null, { wantedBy: member.id, sort: 'wanted', page: pageNum }),
    admin ? listWantShares(c.env.DB, member.id) : Promise.resolve([]),
    // the account the publish form names, as a stamp — ids are reused (§16 #56); only admins publish
    admin ? getUserById(c.env.DB, member.id) : Promise.resolve(null),
  ]);
  const stamp = account && c.env.SESSION_SECRET ? await giftListStamp(c.env.SESSION_SECRET, account) : '';
  const { since, links } = await wantListExtras(
    c.env.DB,
    member.id,
    list.items.map((i) => i.id),
  );
  const origin = new URL(c.req.url).origin;
  const here = (p: number) => `/wants?${new URLSearchParams({ ...(mine ? {} : { member: String(member.id) }), page: String(p) })}`;

  return page(
    c,
    mine ? 'Your want list' : `${member.username}’s want list`,
    <>
      <div class="page-head">
        <div>
          <h1>{mine ? 'Your want list' : `${member.username}’s want list`}</h1>
          <span class="sub">
            {list.total} {list.total === 1 ? 'ITEM' : 'ITEMS'} · NEWEST FIRST
          </span>
        </div>
        {people.length > 1 ? (
          <form method="get" action="/wants" class="inline-form">
            <select name="member" aria-label="Whose want list">
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

      {list.items.length ? (
        <ol class="want-list">
          {list.items.map((item) => (
            <li class="want-card">
              <a href={`/items/${item.id}`} class="want-cover" tabindex={-1} aria-hidden="true">
                <Cover coverKey={item.coverKey} title={item.title} mediaType={item.mediaType} />
              </a>
              <div class="want-body">
                <a href={`/items/${item.id}`} class="want-title">
                  {item.title}
                </a>
                {item.creators ? <small class="want-creators">{item.creators}</small> : null}
                <span class="mline">
                  <small class="muted">{MEDIA_LABEL[item.mediaType]}</small>
                  {item.copies === 0 ? <NotOwnedPill /> : null}
                  {since.get(item.id) ? <small class="mono muted">since {since.get(item.id)!.slice(0, 10)}</small> : null}
                </span>
                <BuyLinks links={links.get(item.id) ?? []} />
                {mine ? (
                  <form method="post" action={`/items/${item.id}/want`} class="inline">
                    <input type="hidden" name="want" value="0" />
                    <input type="hidden" name="back" value="wants" />
                    <button type="submit" class="progress-delete">
                      Take off my list
                    </button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p class="muted">
          {mine ? (
            <>
              Nothing here yet. Use <strong>{wantLabel('book')}</strong> on a book's page — <strong>{wantLabel('vinyl')}</strong> on a
              record's or a game's — or on a result under <a href="/add">Add items</a>, which adds it as Not owned.
            </>
          ) : (
            `Nothing on ${member.username}’s list.`
          )}
        </p>
      )}
      <Pagination page={list.page} pages={list.pages} makeHref={here} />

      {admin ? (
        <section class="gift-lists" id="gift-lists">
          <p class="eyebrow">Gift lists</p>
          {shares.length ? (
            <div class="data-table">
              <table>
                <tbody>
                  {shares.map((v) => (
                    <tr>
                      <td>
                        <a href={`${origin}/share/${v.token}`} class="mono break-anywhere">
                          {origin}/share/{v.token}
                        </a>
                      </td>
                      <td class="actions-cell">
                        <form method="post" action={`/shares/${v.id}`} class="inline-form">
                          <input type="hidden" name="wantUserId" value={String(member.id)} />
                          <button
                            name="action"
                            value="rotate"
                            class="btn"
                            data-confirm="Rotate this gift list's link? Its current URL stops working — anyone you gave it to needs the new one."
                          >
                            Rotate
                          </button>
                          <button name="action" value="delete" class="btn-danger" data-confirm="Remove this gift list's link? The URL stops working. The want list stays.">
                            Remove
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <form method="post" action="/shares" class="inline-form">
            <input type="hidden" name="wantUserId" value={String(member.id)} />
            {/* users.id can be reused once a member is removed: the publish names which account it meant, too */}
            <input type="hidden" name="wantStamp" value={stamp} />
            <button type="submit">{shares.length ? 'Publish another link' : 'Publish as a gift list'}</button>
          </form>
          <p class="muted">
            A gift list is a public, read-only page of everything on this want list as it stands — titles, covers and the
            links under <strong>Where to buy</strong> — so whoever you send it to can choose a present. It follows the list:
            what comes off it leaves the page. It shows no notes, loans, copies, reading or ratings, and is titled “A want
            list” unless names are switched on for share pages under <a href="/shares#names-on-shares">Shared links</a>, when it
            carries the member's display name — never their login. Every link is listed there too.
          </p>
        </section>
      ) : null}
    </>,
  );
});

export default wants;
