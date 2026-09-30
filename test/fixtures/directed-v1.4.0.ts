// A FIXTURE, not app code: v1.4.0's dispatch of a directed message, extracted verbatim with
// `git show v1.4.0:src/federation/directed.ts`, its messages pointed at ./messages-v1.4.0.ts and its receivers at src/,
// whose comments.ts and borrowing.ts are unchanged since 1.4.0 (and in 1.5.0). test/recommend-compat.spec.ts shows what
// it would make of a Recommend if one ever got past 1.4.0's parser — which one never does (ARCH.md §16 #58).
// Regenerate only to model a different release; never edit it by hand.
// A message addressed to this household by one connection — pushed to the inbox or pulled from that
// connection's outbox — handed to the part of connections it's about. Both paths land here, so they can't
// drift apart.
import type { Connection, FederationSettings } from '../../src/db/schema';
import { receiveBorrowing } from '../../src/federation/borrowing';
import { receiveComment, type Outcome } from '../../src/federation/comments';
import type { DirectedMessage } from './messages-v1.4.0';

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
