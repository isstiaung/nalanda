// Comments on reviews between connected households (docs/proposals/connections.md §9): the section under a
// review on an item page, and the routes that write and delete comments. A thread is only ever between this
// household and one other — nothing in it is sent to, or shown to, anyone else.
import { Hono, type Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import {
  commentsOnOurItem,
  getComment,
  getConnection,
  getFederationSettings,
  holdsReviewEntry,
  insertComment,
  sentToday,
  softDeleteComment,
  theyStartedThread,
  type ThreadComment,
} from '../db/federation';
import { getItem } from '../db/queries';
import type { Comment, FederationSettings, Item } from '../db/schema';
import type { AppEnv } from '../env';
import { MAX_COMMENT_CHARS, MAX_SENT_PER_DAY } from '../federation/config';
import { isStamp, itemStamp } from '../federation/items';
import { loadIdentity, type Identity } from '../federation/keys';
import { commentCreate, commentDelete } from '../federation/messages';
import { sendToConnection } from '../federation/outbox';

const comments = new Hono<AppEnv>();

type Enabled = { identity: Identity; settings: FederationSettings };

async function enabled(c: Context<AppEnv>): Promise<Enabled | null> {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return null;
  const settings = await getFederationSettings(c.env.DB);
  return settings ? { identity, settings } : null;
}

/** A comment as either household's pages show it. Everything in it that came from another instance is escaped text. */
export const CommentView: FC<{
  comment: Pick<Comment, 'id' | 'fromUs' | 'authorName' | 'body' | 'createdAt'>;
  household: string;
  canDelete: boolean;
  back: string;
}> = ({ comment, household, canDelete, back }) => (
  <div class="comment">
    <p class="comment-meta">
      <strong>{comment.authorName}</strong> · {comment.fromUs ? 'this library' : household} ·{' '}
      <span class="mono">{comment.createdAt.slice(0, 10)}</span>
      {canDelete ? (
        <form method="post" action={`/comments/${comment.id}/delete`} class="inline">
          <input type="hidden" name="back" value={back} />{' '}
          <button type="submit" class="linklike">
            Delete
          </button>
        </form>
      ) : null}
    </p>
    <p class="prewrap">{comment.body}</p>
  </div>
);

export const CommentForm: FC<{ action: string; fields: Record<string, string>; label: string }> = ({ action, fields, label }) => (
  <form method="post" action={action} class="comment-form">
    {Object.entries(fields).map(([name, value]) => (
      <input type="hidden" name={name} value={value} />
    ))}
    <textarea name="body" rows={2} maxlength={MAX_COMMENT_CHARS} required aria-label={label}></textarea>
    <button type="submit" class="btn">
      {label}
    </button>
  </form>
);

/**
 * The threads on one of this household's items, for its item page — null unless connections are enabled and
 * someone has commented, so the page is unchanged otherwise. One thread per household.
 */
export async function itemComments(c: Context<AppEnv>, item: Item): Promise<Child | null> {
  if (!(await enabled(c))) return null;
  const rows = await commentsOnOurItem(c.env.DB, item.id);
  if (!rows.length) return null;
  const threads = new Map<number, ThreadComment[]>();
  for (const row of rows) threads.set(row.connectionId, [...(threads.get(row.connectionId) ?? []), row]);
  const back = `/items/${item.id}#comments`;
  return (
    <div class="detail-section" id="comments">
      <p class="eyebrow">Comments from connections</p>
      {[...threads.values()].map((thread) => {
        const first = thread[0]!;
        return (
          <div class="thread">
            <p class="thread-head">
              With <strong>{first.householdName}</strong>
            </p>
            {thread.map((comment) => (
              <CommentView comment={comment} household={first.householdName} canDelete={true} back={back} />
            ))}
            {first.connectionStatus === 'active' ? (
              <CommentForm action={`/items/${item.id}/comments`} fields={{ connectionId: String(first.connectionId) }} label="Reply" />
            ) : null}
          </div>
        );
      })}
      <p class="muted">Each thread is seen only by this library and the household in it.</p>
    </div>
  );
}

const digits = (raw: unknown) => (typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : null);
const commentText = (raw: unknown) => (typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').trim() : '');
const safeBack = (raw: unknown) => (typeof raw === 'string' && /^\/(items\/\d{1,15}|feed)(#[\w-]*)?$/.test(raw) ? raw : '/feed');

/** A reply on one of our reviews, into a thread the other household started. */
comments.post('/items/:id/comments', async (c) => {
  const ctx = await enabled(c);
  if (!ctx) return c.notFound();
  const item = await getItem(c.env.DB, Number(c.req.param('id')));
  if (!item) return c.notFound();
  const back = `/items/${item.id}#comments`;
  const form = await c.req.parseBody();
  const text = commentText(form['body']);
  const connectionId = digits(form['connectionId']);
  const connection = connectionId ? await getConnection(c.env.DB, connectionId) : null;
  if (!connection || connection.status !== 'active' || !text || text.length > MAX_COMMENT_CHARS) return c.redirect(back);
  if (!(await theyStartedThread(c.env.DB, connection.id, item.id))) return c.redirect(back);
  if ((await sentToday(c.env.DB, connection.id)) >= MAX_SENT_PER_DAY) return c.redirect(back);

  const user = c.get('user');
  const message = commentCreate(
    ctx.settings.baseUrl,
    { owner: ctx.settings.baseUrl, item: item.id, stamp: await itemStamp(item) },
    user.username,
    text,
  );
  await insertComment(c.env.DB, {
    activityId: message.id,
    connectionId: connection.id,
    ourItemId: item.id,
    fromUs: true,
    authorName: message.author,
    authorId: user.id,
    body: text,
    createdAt: message.published,
  });
  await sendToConnection(c, ctx.identity, ctx.settings, connection, message);
  return c.redirect(back);
});

/** A comment on a connection's review, from its card on the Feed — only for a review this household follows. */
comments.post('/feed/comments', async (c) => {
  const ctx = await enabled(c);
  if (!ctx) return c.notFound();
  const form = await c.req.parseBody();
  const text = commentText(form['body']);
  const connectionId = digits(form['connectionId']);
  const itemId = digits(form['itemId']);
  const stamp = isStamp(form['stamp']) ? form['stamp'] : null;
  const connection = connectionId ? await getConnection(c.env.DB, connectionId) : null;
  const back = `/feed#thread-${connectionId ?? 0}-${itemId ?? 0}`;
  if (!connection || connection.status !== 'active' || !itemId || !stamp || !text || text.length > MAX_COMMENT_CHARS) {
    return c.redirect(back);
  }
  if (!(await holdsReviewEntry(c.env.DB, connection.id, itemId, stamp))) return c.redirect(back);
  if ((await sentToday(c.env.DB, connection.id)) >= MAX_SENT_PER_DAY) return c.redirect(back);

  const user = c.get('user');
  const message = commentCreate(ctx.settings.baseUrl, { owner: connection.baseUrl, item: itemId, stamp }, user.username, text);
  await insertComment(c.env.DB, {
    activityId: message.id,
    connectionId: connection.id,
    theirItemId: itemId,
    theirItemStamp: stamp,
    fromUs: true,
    authorName: message.author,
    authorId: user.id,
    body: text,
    createdAt: message.published,
  });
  await sendToConnection(c, ctx.identity, ctx.settings, connection, message);
  return c.redirect(back);
});

/** Ours to delete: anything this household wrote, and anything in a thread on its own review. */
comments.post('/comments/:id/delete', async (c) => {
  const ctx = await enabled(c);
  if (!ctx) return c.notFound();
  const back = safeBack((await c.req.parseBody())['back']);
  const comment = await getComment(c.env.DB, Number(c.req.param('id')));
  if (!comment || comment.deletedAt || (!comment.fromUs && comment.ourItemId === null)) return c.redirect(back);
  await softDeleteComment(c.env.DB, comment.id);
  const connection = await getConnection(c.env.DB, comment.connectionId);
  if (connection?.status === 'active') {
    await sendToConnection(c, ctx.identity, ctx.settings, connection, commentDelete(ctx.settings.baseUrl, comment.activityId));
  }
  return c.redirect(back);
});

export default comments;
