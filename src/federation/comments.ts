// Receiving comments from a connection (docs/proposals/connections.md §9). A comment arrives pushed to the
// inbox or pulled from the connection's outbox; both are handled here, and both are idempotent by comment id.
//
// A thread is only ever between this household and the one it came from. Comments on this household's
// reviews are kept only for reviews it shares with connections; comments on theirs only while this household
// follows that review, since our copy of a thread lives with its feed entry.
import {
  commentByActivity,
  holdsReviewEntry,
  insertComment,
  itemIsShared,
  recordDeletionFirst,
  softDeleteComment,
} from '../db/federation';
import { getItem } from '../db/queries';
import type { Connection, FederationSettings } from '../db/schema';
import type { CommentCreate, CommentDelete, DirectedMessage } from './messages';

export type Outcome = { status: 200 | 400 | 403 | 404; body: Record<string, string> };

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const hasReview = (review: string | null) => !!review && review.replace(/\r/g, '').trim() !== '';

export function receiveDirected(
  d1: D1Database,
  settings: FederationSettings,
  connection: Connection,
  message: DirectedMessage,
): Promise<Outcome> {
  return message.type === 'CommentCreate'
    ? receiveComment(d1, settings, connection, message)
    : receiveDeletion(d1, connection, message);
}

async function receiveComment(
  d1: D1Database,
  settings: FederationSettings,
  connection: Connection,
  m: CommentCreate,
): Promise<Outcome> {
  // A date from the future is stored as now, as feed entries are.
  const createdAt = m.published > sqlNow() ? sqlNow() : m.published;
  const values = { activityId: m.id, connectionId: connection.id, fromUs: false, authorName: m.author, body: m.content, createdAt };

  if (m.inReplyTo.owner === settings.baseUrl) {
    // On one of our reviews. Unknown, unreviewed and unshared items answer alike, so nothing is revealed.
    const item = await getItem(d1, m.inReplyTo.item);
    if (!item || !hasReview(item.review) || !(await itemIsShared(d1, item))) {
      return { status: 404, body: { error: 'no such review' } };
    }
    const row = await insertComment(d1, { ...values, ourItemId: item.id });
    return { status: 200, body: { status: row ? 'received' : 'already received' } };
  }

  if (m.inReplyTo.owner === connection.baseUrl) {
    // On one of theirs: kept only while we follow that review.
    if (!(await holdsReviewEntry(d1, connection.id, m.inReplyTo.item))) return { status: 200, body: { status: 'not kept' } };
    const row = await insertComment(d1, { ...values, theirItemId: m.inReplyTo.item });
    return { status: 200, body: { status: row ? 'received' : 'already received' } };
  }

  // Pairwise: never a review of some third household.
  return { status: 400, body: { error: 'a comment must be on a review of one of the two households' } };
}

async function receiveDeletion(d1: D1Database, connection: Connection, m: CommentDelete): Promise<Outcome> {
  const comment = await commentByActivity(d1, connection.id, m.comment);
  if (!comment) {
    // Its comment may not have arrived yet — it could still be waiting in their outbox. Remember the deletion.
    await recordDeletionFirst(d1, connection.id, m.comment);
    return { status: 200, body: { status: 'deleted' } };
  }
  // They may withdraw their own comments, and remove any comment in a thread on their own review.
  if (!comment.fromUs || comment.theirItemId !== null) {
    if (!comment.deletedAt) await softDeleteComment(d1, comment.id);
    return { status: 200, body: { status: 'deleted' } };
  }
  return { status: 403, body: { error: 'not theirs to delete' } };
}
