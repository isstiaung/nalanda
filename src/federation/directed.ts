// A message addressed to this household by one connection — pushed to the inbox or pulled from that
// connection's outbox — handed to the part of connections it's about. Both paths land here, so they can't
// drift apart.
import type { Connection, FederationSettings } from '../db/schema';
import { receiveBorrowing } from './borrowing';
import { receiveComment, type Outcome } from './comments';
import type { DirectedMessage } from './messages';

export function receiveDirected(
  d1: D1Database,
  settings: FederationSettings,
  connection: Connection,
  message: DirectedMessage,
): Promise<Outcome> {
  return message.type === 'CommentCreate' || message.type === 'CommentDelete'
    ? receiveComment(d1, settings, connection, message)
    : receiveBorrowing(d1, connection, message);
}
