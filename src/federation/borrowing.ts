// Receiving borrowing messages from a connection (docs/proposals/connections.md §10): requests for this
// household's books, the lender's answers to this household's requests, and return notices. Pushed or
// pulled, each is idempotent — by activity id, or by a state that only moves forward.
import {
  availability,
  countPendingIncoming,
  hasPendingIncoming,
  insertBorrowRequest,
  itemIsShared,
  markBorrowedReturned,
  recordBorrowed,
  requestByActivity,
  requestStatus,
  setRequestStatus,
} from '../db/federation';
import { getItem } from '../db/queries';
import type { Connection } from '../db/schema';
import type { Outcome } from './comments';
import { MAX_PENDING_REQUESTS_PER_CONNECTION } from './config';
import type { BorrowMessage, BorrowRequest } from './messages';

export async function receiveBorrowing(d1: D1Database, connection: Connection, message: BorrowMessage): Promise<Outcome> {
  switch (message.type) {
    case 'BorrowRequest':
      return receiveRequest(d1, connection, message);

    case 'BorrowWithdraw': {
      // Only a request they sent us, and only while it waits.
      const request = await requestByActivity(d1, connection.id, message.request, true);
      if (!request) return { status: 404, body: { error: 'no such request' } };
      await setRequestStatus(d1, request.id, 'withdrawn', ['pending']);
      return { status: 200, body: { status: 'withdrawn' } };
    }

    case 'BorrowAccept': {
      // Only an answer to a request we sent them.
      const request = await requestByActivity(d1, connection.id, message.request, false);
      if (!request || request.theirItemId === null) return { status: 404, body: { error: 'no such request' } };
      // Accepted even if we withdrew meanwhile: they have lent it, so it belongs on the Borrowed page.
      await setRequestStatus(d1, request.id, 'accepted', ['pending', 'withdrawn'], message.dueOn);
      await recordBorrowed(d1, {
        connectionId: connection.id,
        requestActivityId: request.activityId,
        theirItemId: request.theirItemId,
        title: request.itemTitle,
        coverKey: request.coverKey,
        borrowedOn: message.loanedOn,
        dueOn: message.dueOn,
      });
      return { status: 200, body: { status: 'accepted' } };
    }

    case 'BorrowDecline': {
      const request = await requestByActivity(d1, connection.id, message.request, false);
      if (!request) return { status: 404, body: { error: 'no such request' } };
      await setRequestStatus(d1, request.id, 'declined', ['pending']);
      return { status: 200, body: { status: 'declined' } };
    }

    case 'Returned': {
      const request = await requestByActivity(d1, connection.id, message.request, false);
      if (!request) return { status: 404, body: { error: 'no such request' } };
      const marked = await markBorrowedReturned(d1, connection.id, message.request, message.returnedOn);
      return { status: 200, body: { status: marked ? 'returned' : 'already returned' } };
    }
  }
}

/**
 * A request for one of our books. Unknown and unshared books answer alike, so nothing is revealed; a shared
 * book that isn't free says so, since connections can already see availability.
 */
async function receiveRequest(d1: D1Database, connection: Connection, m: BorrowRequest): Promise<Outcome> {
  if (await requestStatus(d1, m.id)) return { status: 200, body: { status: 'already received' } };
  const item = await getItem(d1, m.item);
  if (!item || !(await itemIsShared(d1, item))) return { status: 404, body: { error: 'no such item' } };
  if (item.copies === 0 || !(await availability(d1, [item])).get(item.id)) {
    return { status: 409, body: { error: 'not available' } };
  }
  if (await hasPendingIncoming(d1, connection.id, item.id)) return { status: 409, body: { error: 'already requested' } };
  if ((await countPendingIncoming(d1, connection.id)) >= MAX_PENDING_REQUESTS_PER_CONNECTION) {
    return { status: 409, body: { error: 'too many requests waiting' } };
  }
  const row = await insertBorrowRequest(d1, {
    activityId: m.id,
    connectionId: connection.id,
    incoming: true,
    ourItemId: item.id,
    itemTitle: item.title,
    coverKey: item.coverKey,
    requesterName: m.requester,
    note: m.note,
  });
  return { status: 200, body: { status: row ? 'received' : 'already received' } };
}
