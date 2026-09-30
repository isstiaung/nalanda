// Notifications (ARCH.md §16 #36): what happened with connections that someone here should know about — a
// household asking to connect, a request to borrow, a comment. In-app only, read per person.
//
// Household names and titles come from other instances and render only as escaped text (CLAUDE.md), and
// every link is built by this instance when the event is recorded.
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { listNotifications, markNotificationsSeen, notificationsWatermark, pruneNotifications } from '../db/federation';
import type { Notification } from '../db/schema';
import type { AppEnv } from '../env';
import { loadIdentity } from '../federation/keys';
import { page } from '../views/layout';
import { ledgerDateTime } from '../lib/dates';

const notificationsRoutes = new Hono<AppEnv>();

const SHOWN = 100;

/** One sentence per kind. Who is always a household; what is a book title, when there is one. */
const Sentence: FC<{ n: Notification }> = ({ n }) => {
  const who = <strong>{n.householdName}</strong>;
  const what = n.subject ? <em>{n.subject}</em> : 'a book';
  switch (n.kind) {
    case 'connection_request':
      return <>{who} wants to connect — confirm or decline</>;
    case 'connection_accepted':
      return <>{who} accepted — you're connected</>;
    case 'connection_declined':
      return <>{who} declined to connect</>;
    case 'connection_withdrawn':
      return <>{who} withdrew their request to connect</>;
    case 'disconnected':
      return <>{who} disconnected</>;
    case 'borrow_request':
      return (
        <>
          {who} asked to borrow {what}
        </>
      );
    case 'borrow_withdrawn':
      return (
        <>
          {who} withdrew their request for {what}
        </>
      );
    case 'borrow_accepted':
      return (
        <>
          {who} lent you {what}
        </>
      );
    case 'borrow_declined':
      return (
        <>
          {who} declined your request for {what}
        </>
      );
    case 'returned':
      return (
        <>
          {who} marked {what} as returned
        </>
      );
    case 'comment':
      return (
        <>
          {who} commented on {n.subject ? what : 'a review'}
        </>
      );
    case 'recommendation':
      return (
        <>
          {who} recommended {n.subject ? what : 'something'} to you
        </>
      );
  }
};

notificationsRoutes.get('/notifications', async (c) => {
  // Every notification is about a connection, so there are none without them.
  if (!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY))) return c.notFound();
  const user = c.get('user');
  const [readUpTo, list] = await Promise.all([
    notificationsWatermark(c.env.DB, user.id),
    listNotifications(c.env.DB, user.id, SHOWN),
  ]);
  // Up to the newest shown, not "now": one that lands while this page renders stays unread.
  await Promise.all([list[0] ? markNotificationsSeen(c.env.DB, user.id, list[0].id) : Promise.resolve(), pruneNotifications(c.env.DB)]);

  return page(
    c,
    'Notifications',
    <>
      <div class="page-head">
        <div>
          <h1>Notifications</h1>
          <span class="sub">CONNECTIONS, BORROWING, COMMENTS AND RECOMMENDATIONS</span>
        </div>
      </div>
      {list.length ? (
        <ol class="notifications">
          {list.map((n) => (
            <li class={n.id > readUpTo ? 'unread' : undefined}>
              <a href={n.href}>
                {/* the dot is colour alone; this says it */}
                {n.id > readUpTo ? <span class="sr-only">New: </span> : null}
                <Sentence n={n} />
              </a>
              <span class="mono muted">{ledgerDateTime(n.at)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p class="muted">Nothing yet. When a household asks to connect, wants to borrow something, comments on a review or recommends something to you, it shows up here.</p>
      )}
      <p class="muted">New activity from the households you follow is counted on Feed instead. Notifications are kept for six months.</p>
    </>,
  );
});

export default notificationsRoutes;
