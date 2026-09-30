// A message addressed to this household by one connection — pushed to the inbox or pulled from that
// connection's outbox — handed to the part of connections it's about. Both paths land here, so they can't
// drift apart.
//
// Only a type parseInboxMessage() knows ever reaches this: an unknown one is refused there, before any of this
// runs. Up to 1.4.0 this was a two-way ternary whose borrowing side answered nothing for a type it didn't know —
// which is why a new type is sent only to households that advertise it (§16 #58, test/fixtures/directed-v1.4.0.ts).
import type { Connection, FederationSettings } from '../db/schema';
import { receiveBorrowing } from './borrowing';
import { receiveComment, type Outcome } from './comments';
import type { DirectedMessage } from './messages';
import { receiveRecommendation } from './recommendations';

export function receiveDirected(
  d1: D1Database,
  settings: FederationSettings,
  connection: Connection,
  message: DirectedMessage,
): Promise<Outcome> {
  switch (message.type) {
    case 'CommentCreate':
    case 'CommentDelete':
      return receiveComment(d1, settings, connection, message);
    case 'Recommend':
      return receiveRecommendation(d1, connection, message);
    default:
      return receiveBorrowing(d1, connection, message);
  }
}
